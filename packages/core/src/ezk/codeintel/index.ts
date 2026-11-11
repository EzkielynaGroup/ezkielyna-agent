// Ezkielyna Agent v3 (Wave C, codeintel, DESIGN-V3 T6): per-project code index in SQLite FTS5 (BM25). No embeddings.
// One additive file per project (<data>/ezk/codeintel/<project hash>.db). Rows: every listed file (path search) plus
// every definition tree-sitter finds (name, kind, signature, doc comment). References are kept per file for the repo
// map (T7). Built lazily on the first search, then refreshed incrementally by mtime + size; never a watcher.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { type Sqlite, openSqlite } from "../search/sqlite"
import { toMatchQuery } from "../search/fts"
import { grammarFor } from "../treesitter/loader"
import { listProjectFiles } from "./files"
import { type Def, type DefKind, extractTags } from "./tags"

export const MAX_FILE_BYTES = 512 * 1024
export const MAX_HITS = 20
const INDEX_VERSION = "1"
const BATCH = 200
// Vendored and generated code: the path stays searchable, but its symbols would crowd out the project's own.
const NO_SYMBOLS = /(^|\/)(vendor|third_party|node_modules)\/|\.pb\.go$|(^|\/)zz_generated|_generated\.\w+$|\.min\.js$/
const STAT_CONCURRENCY = 256
// bm25 column weights: name, words (split identifier), path, signature, doc
const BM25 = "bm25(code_fts, 10.0, 5.0, 2.0, 1.5, 1.0)"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, mtime INTEGER NOT NULL, size INTEGER NOT NULL, lang TEXT);
CREATE TABLE IF NOT EXISTS defs (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, line INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, signature TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS defs_file ON defs(file_id);
CREATE TABLE IF NOT EXISTS refs (file_id INTEGER NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS refs_file ON refs(file_id);
`
// Contentless: the text lives in `defs`/`files`, FTS5 keeps only the inverted index (about half the file size).
// `contentless_delete` needs SQLite 3.43+ (Bun and Electron ship newer); older builds fall back to a normal table.
const FTS = (contentless: boolean) =>
  `CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(name, words, path, signature, doc, ${contentless ? "content = '', contentless_delete = 1, " : ""}tokenize = 'unicode61 remove_diacritics 2')`

export type HitKind = DefKind | "file"

export interface CodeHit {
  path: string
  line: number
  kind: HitKind
  name: string
  signature: string
}

export interface SyncResult {
  files: number
  parsed: number
  removed: number
  /** false when the time budget ran out; the next sync continues where this one stopped */
  done: boolean
  ms: number
  source: "git" | "walk"
}

export interface GraphRows {
  defs: { file: string; name: string; line: number; kind: DefKind; signature: string }[]
  refs: { file: string; name: string; n: number }[]
  files: string[]
}

/** `<data>/ezk/codeintel/<sha1(root)[:16]>.db` */
export function indexFile(dataDir: string, root: string) {
  const id = createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 16)
  return path.join(dataDir, "ezk", "codeintel", `${id}.db`)
}

/** `getUserName` -> `get user name`, `HTTPServer` -> `http server`, `snake_case` -> `snake case`. */
export function splitIdentifier(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-$.]+/g, " ")
    .toLowerCase()
    .trim()
}

export class CodeIndex {
  private constructor(
    private db: Sqlite,
    readonly file: string,
    readonly root: string,
  ) {}

  static async open(file: string, root: string): Promise<CodeIndex> {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const db = await openSqlite(file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {}
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;")
    const create = () => {
      db.exec(SCHEMA)
      try {
        db.exec(FTS(true))
      } catch {
        db.exec(FTS(false))
      }
    }
    create()
    const version = db.get<{ v: string }>("SELECT v FROM meta WHERE k = 'index_version'")?.v
    if (version !== INDEX_VERSION) {
      db.exec("DROP TABLE IF EXISTS code_fts; DROP TABLE IF EXISTS defs; DROP TABLE IF EXISTS refs; DROP TABLE IF EXISTS files; DELETE FROM meta;")
      create()
      db.run("INSERT INTO meta(k, v) VALUES('index_version', ?)", INDEX_VERSION)
    }
    return new CodeIndex(db, file, path.resolve(root))
  }

  /** Open an existing index for queries only. The short-lived index worker owns all writes. */
  static async openReadOnly(file: string, root: string): Promise<CodeIndex> {
    if (!fs.existsSync(file)) throw new Error("Code index is not ready yet")
    const db = await openSqlite(file, { readonly: true })
    try {
      const version = db.get<{ v: string }>("SELECT v FROM meta WHERE k = 'index_version'")?.v
      if (version !== INDEX_VERSION) throw new Error("Code index is not ready yet")
      return new CodeIndex(db, file, path.resolve(root))
    } catch (error) {
      db.close()
      throw error
    }
  }

  close() {
    this.db.close()
  }

  stats() {
    const files = this.db.get<{ n: number }>("SELECT count(*) AS n FROM files")?.n ?? 0
    const defs = this.db.get<{ n: number }>("SELECT count(*) AS n FROM defs WHERE kind <> 'file'")?.n ?? 0
    const bytes = ["", "-wal"].reduce((sum, s) => sum + (fs.statSync(this.file + s, { throwIfNoEntry: false })?.size ?? 0), 0)
    return { files, defs, bytes }
  }

  meta(k: string) {
    return this.db.get<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v
  }

  setMeta(k: string, v: string) {
    this.db.run("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v)
  }

  /** Bring the index up to date with the files on disk. Stops early (done=false) once `budgetMs` is spent. */
  /** `git: false` for projects the user has not trusted (no git process is started). */
  async sync(opts: { budgetMs?: number; maxFiles?: number; git?: boolean; batchSize?: number; onProgress?: (parsed: number, total: number) => void } = {}): Promise<SyncResult> {
    const t0 = performance.now()
    const deadline = t0 + (opts.budgetMs ?? Infinity)
    const list = await listProjectFiles(this.root, opts.maxFiles, opts.git ?? true)
    const known = new Map(this.db.all<{ id: number; path: string; mtime: number; size: number }>("SELECT id, path, mtime, size FROM files").map((r) => [r.path, r]))
    const stats = await statAll(this.root, list.files)
    const present = new Set<string>()
    const changed: { path: string; mtime: number; size: number }[] = []
    for (const [i, rel] of list.files.entries()) {
      const st = stats[i]
      if (!st) continue
      present.add(rel)
      const prev = known.get(rel)
      if (prev && prev.mtime === st.mtime && prev.size === st.size) continue
      changed.push({ path: rel, ...st })
    }
    const removed = [...known.values()].filter((r) => !present.has(r.path))
    if (removed.length) this.db.transaction(() => removed.forEach((r) => this.drop(r.id, true)))

    let parsed = 0
    const batchSize = Math.max(1, Math.min(BATCH, opts.batchSize ?? BATCH))
    for (let i = 0; i < changed.length; i += batchSize) {
      if (performance.now() > deadline) break
      const batch = changed.slice(i, i + batchSize)
      const rows = await Promise.all(batch.map((f) => this.read(f)))
      this.db.transaction(() => rows.forEach((row) => this.write(row, known.get(row.path)?.id)))
      parsed += batch.length
      opts.onProgress?.(parsed, changed.length)
    }
    const done = parsed === changed.length
    if (done) this.setMeta("synced_at", String(Date.now()))
    return { files: present.size, parsed, removed: removed.length, done, ms: Math.round(performance.now() - t0), source: list.source }
  }

  private async read(f: { path: string; mtime: number; size: number }) {
    const lang = grammarFor(f.path)
    if (!lang || f.size > MAX_FILE_BYTES || NO_SYMBOLS.test(f.path)) return { ...f, lang, defs: [] as Def[], refs: new Map<string, number>() }
    const source = await fs.promises.readFile(path.join(this.root, f.path), "utf8").catch(() => "")
    // Minified bundles: one huge line, no useful symbols.
    const tags = source && !looksMinified(source) ? await extractTags(lang, source) : undefined
    return { ...f, lang, defs: tags?.defs ?? [], refs: tags?.refs ?? new Map<string, number>() }
  }

  private write(row: { path: string; mtime: number; size: number; lang?: string; defs: Def[]; refs: Map<string, number> }, existing?: number) {
    if (existing !== undefined) this.drop(existing, false)
    const fileID = existing ?? this.insertFile(row)
    if (existing !== undefined) this.db.run("UPDATE files SET mtime = ?, size = ?, lang = ? WHERE id = ?", row.mtime, row.size, row.lang ?? null, fileID)
    this.insertDef(fileID, row.path, { name: path.basename(row.path), kind: "file", line: 1, signature: "", doc: "" })
    for (const def of row.defs) this.insertDef(fileID, row.path, def)
    for (const [name, n] of row.refs) this.db.run("INSERT INTO refs(file_id, name, n) VALUES(?, ?, ?)", fileID, name, n)
  }

  private insertFile(row: { path: string; mtime: number; size: number; lang?: string }) {
    this.db.run("INSERT INTO files(path, mtime, size, lang) VALUES(?, ?, ?, ?)", row.path, row.mtime, row.size, row.lang ?? null)
    return this.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id
  }

  private insertDef(fileID: number, rel: string, def: Omit<Def, "kind"> & { kind: HitKind }) {
    this.db.run("INSERT INTO defs(file_id, line, kind, name, signature) VALUES(?, ?, ?, ?, ?)", fileID, def.line, def.kind, def.name, def.signature)
    const id = this.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id
    // File rows are found through the path columns only, so a symbol outranks a file of the same name.
    const file = def.kind === "file"
    const words = splitIdentifier(file ? rel.replace(/\.[^./]+$/, "") : def.name)
    this.db.run("INSERT INTO code_fts(rowid, name, words, path, signature, doc) VALUES(?, ?, ?, ?, ?, ?)", id, file ? "" : def.name, file ? "" : words, file ? `${rel} ${words}` : rel, def.signature, def.doc)
  }

  /** Remove a file's definitions and references (and the file row itself when `file` is true). */
  private drop(fileID: number, file: boolean) {
    this.db.run("DELETE FROM code_fts WHERE rowid IN (SELECT id FROM defs WHERE file_id = ?)", fileID)
    this.db.run("DELETE FROM defs WHERE file_id = ?", fileID)
    this.db.run("DELETE FROM refs WHERE file_id = ?", fileID)
    if (file) this.db.run("DELETE FROM files WHERE id = ?", fileID)
  }

  /** BM25 search: all words first, then any word, then the split words of camelCase/snake_case input. */
  search(query: string, limit = MAX_HITS): CodeHit[] {
    const max = Math.min(Math.max(limit, 1), MAX_HITS)
    const run = (match: string) =>
      this.db.all<CodeHit & { rank: number }>(
        `SELECT f.path AS path, d.line AS line, d.kind AS kind, d.name AS name, d.signature AS signature, ${BM25} AS rank
           FROM code_fts JOIN defs d ON d.id = code_fts.rowid JOIN files f ON f.id = d.file_id
          WHERE code_fts MATCH ? ORDER BY rank LIMIT ?`,
        match,
        max * 3,
      )
    const split = splitIdentifier(query)
    const stages = [toMatchQuery(query, "and"), toMatchQuery(query, "or"), toMatchQuery(split, "and"), toMatchQuery(split, "or")]
    const tried = new Set<string>()
    for (const match of stages) {
      if (!match || tried.has(match)) continue
      tried.add(match)
      const rows = run(match)
      if (!rows.length) continue
      // An exact (case-insensitive) name match beats a better BM25 score on a longer name.
      const exact = new Set(query.toLowerCase().split(/\s+/).filter(Boolean))
      return rows
        .map((r) => ({ ...r, exact: exact.has(r.name.toLowerCase()) ? 0 : 1 }))
        .sort((a, b) => a.exact - b.exact || a.rank - b.rank)
        .slice(0, max)
        .map((r) => ({ path: r.path, line: r.line, kind: r.kind, name: r.name, signature: r.signature }))
    }
    return []
  }

  /** Every definition and reference, for the repo map graph. */
  graph(): GraphRows {
    return {
      defs: this.db.all<GraphRows["defs"][number]>(
        "SELECT f.path AS file, d.name AS name, d.line AS line, d.kind AS kind, d.signature AS signature FROM defs d JOIN files f ON f.id = d.file_id WHERE d.kind <> 'file'",
      ),
      refs: this.db.all<GraphRows["refs"][number]>("SELECT f.path AS file, r.name AS name, r.n AS n FROM refs r JOIN files f ON f.id = r.file_id"),
      files: this.db.all<{ path: string }>("SELECT path FROM files").map((r) => r.path),
    }
  }

  static drop(file: string) {
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(file + s, { force: true })
  }
}

/** One line per hit: `path:line  kind  name  signature`. */
export function formatCodeHits(hits: CodeHit[]) {
  return hits.map((h) => `${h.path}:${h.line}  ${h.kind}  ${h.name}${h.signature ? `  ${h.signature}` : ""}`).join("\n")
}

function looksMinified(source: string) {
  const lines = source.length / (source.split("\n", 2000).length || 1)
  return source.length > 20_000 && lines > 1000
}

async function statAll(root: string, files: string[]) {
  const out: ({ mtime: number; size: number } | undefined)[] = new Array(files.length)
  for (let i = 0; i < files.length; i += STAT_CONCURRENCY) {
    await Promise.all(
      files.slice(i, i + STAT_CONCURRENCY).map(async (rel, j) => {
        // lstat: a symlink could point outside the project, so links are not followed.
        const st = await fs.promises.lstat(path.join(root, rel)).catch(() => undefined)
        out[i + j] = st?.isFile() ? { mtime: Math.floor(st.mtimeMs), size: st.size } : undefined
      }),
    )
  }
  return out
}
