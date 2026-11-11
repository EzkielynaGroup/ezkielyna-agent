// Ezkielyna Agent v1.1: FTS5 session search. A separate, additive SQLite file (<data>/ezk/search.db): downgrading or
// deleting it never touches the sessions database. The index is built LAZILY on the first search and then kept up to date
// incrementally (cursor on part.time_updated). BM25 ranking, no LLM, no embeddings, no new dependency.
import fs from "node:fs"
import path from "node:path"
import type { SearchHit } from "../contracts"
import { scanForSecrets } from "../memory/scanner"
import { type Sqlite, openSqlite } from "./sqlite"

export const MAX_INDEXED_CHARS = 20_000
export const SNIPPET_TOKENS = 24
const INDEX_VERSION = "2"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  part_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  t INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_session ON docs(session_id);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(content, tokenize = 'porter unicode61 remove_diacritics 2');
`

interface SourceRow {
  id: string
  session_id: string
  message_id: string
  time_updated: number
  text: string | null
  role: string | null
  synthetic: number | null
  ignored: number | null
}

/** Turn free text into a safe FTS5 query: quoted word tokens, last one as a prefix. mode "and" first, "or" as recall fallback. */
export function toMatchQuery(input: string, mode: "and" | "or" = "and"): string | undefined {
  const tokens = (input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 0).slice(0, 8)
  if (!tokens.length) return undefined
  const parts = tokens.map((t, i) => (i === tokens.length - 1 && t.length >= 2 ? `"${t}"*` : `"${t}"`))
  return parts.join(mode === "and" ? " " : " OR ")
}

export class SearchIndex {
  private constructor(private db: Sqlite, readonly file: string) {}

  static async open(file: string): Promise<SearchIndex> {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const db = await openSqlite(file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {}
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;")
    db.exec(SCHEMA)
    if (db.get<{ v: string }>("SELECT v FROM meta WHERE k = 'index_version'")?.v !== INDEX_VERSION) {
      db.exec("DROP TABLE IF EXISTS msg_fts; DROP TABLE IF EXISTS docs; DELETE FROM meta;")
      db.exec(SCHEMA)
      db.run("INSERT INTO meta(k, v) VALUES('index_version', ?)", INDEX_VERSION)
    }
    return new SearchIndex(db, file)
  }

  close() {
    this.db.close()
  }

  private meta(k: string) {
    return this.db.get<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v
  }
  private setMeta(k: string, v: string) {
    this.db.run("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v)
  }

  count() {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM docs")?.n ?? 0
  }

  /** Ingest rows from the sessions DB newer than the cursor. Re-indexed parts (streamed text) are replaced. */
  sync(source: Sqlite, opts: { skipSessions?: Set<string>; onlySessions?: Set<string>; batch?: number; maxBatches?: number } = {}): { indexed: number; done: boolean } {
    const batch = opts.batch ?? 2000
    const skip = opts.skipSessions ?? new Set<string>()
    let cursorT = Number(this.meta("cursor_t") ?? 0)
    let cursorId = this.meta("cursor_id") ?? ""
    let indexed = 0
    for (let b = 0; b < (opts.maxBatches ?? Infinity); b++) {
      const rows = source.all<SourceRow>(
        `SELECT p.id AS id, p.session_id AS session_id, p.message_id AS message_id, p.time_updated AS time_updated,
                json_extract(p.data, '$.text') AS text, json_extract(m.data, '$.role') AS role,
                json_extract(p.data, '$.synthetic') AS synthetic, json_extract(p.data, '$.ignored') AS ignored
           FROM part p JOIN message m ON m.id = p.message_id
          WHERE json_extract(p.data, '$.type') = 'text'
            AND (p.time_updated > ? OR (p.time_updated = ? AND p.id > ?))
          ORDER BY p.time_updated, p.id LIMIT ?`,
        cursorT,
        cursorT,
        cursorId,
        batch,
      )
      if (!rows.length) return { indexed, done: true }
      this.db.transaction(() => {
        for (const r of rows) {
          const prev = this.db.get<{ id: number }>("SELECT id FROM docs WHERE part_id = ?", r.id)
          if (prev) {
            this.db.run("DELETE FROM msg_fts WHERE rowid = ?", prev.id)
            this.db.run("DELETE FROM docs WHERE id = ?", prev.id)
          }
          const text = (r.text ?? "").trim()
          if (
            !text ||
            r.synthetic ||
            r.ignored ||
            skip.has(r.session_id) ||
            (opts.onlySessions && !opts.onlySessions.has(r.session_id)) ||
            !scanForSecrets(text).ok
          ) continue
          this.db.run("INSERT INTO docs(part_id, session_id, message_id, role, t) VALUES(?, ?, ?, ?, ?)", r.id, r.session_id, r.message_id, r.role ?? "user", r.time_updated)
          const rowid = this.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id
          this.db.run("INSERT INTO msg_fts(rowid, content) VALUES(?, ?)", rowid, text.slice(0, MAX_INDEXED_CHARS))
          indexed++
        }
      })
      const last = rows[rows.length - 1]!
      cursorT = last.time_updated
      cursorId = last.id
      this.setMeta("cursor_t", String(cursorT))
      this.setMeta("cursor_id", cursorId)
      if (rows.length < batch) return { indexed, done: true }
    }
    return { indexed, done: false }
  }

  /** Drop everything indexed for a session (used when it becomes private or is deleted). */
  forgetSession(sessionID: string) {
    this.db.transaction(() => {
      for (const d of this.db.all<{ id: number }>("SELECT id FROM docs WHERE session_id = ?", sessionID)) this.db.run("DELETE FROM msg_fts WHERE rowid = ?", d.id)
      this.db.run("DELETE FROM docs WHERE session_id = ?", sessionID)
    })
  }

  search(query: string, opts: { limit?: number; sessionID?: string; excludeSessions?: Set<string>; includeSessions?: Set<string> } = {}): SearchHit[] {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20)
    if (opts.includeSessions && !opts.includeSessions.size) return []
    const groups: (string[] | undefined)[] = opts.includeSessions
      ? [...opts.includeSessions].reduce<string[][]>((out, id, i) => {
          if (i % 800 === 0) out.push([])
          out[out.length - 1]!.push(id)
          return out
        }, [])
      : [undefined]
    const run = (match: string) => {
      const rows: { part_id: string; session_id: string; message_id: string; role: string; t: number; snip: string; rank: number }[] = []
      for (const group of groups) {
        const sessionFilter = opts.sessionID ? "AND d.session_id = ?" : ""
        const includeFilter = group ? `AND d.session_id IN (${group.map(() => "?").join(",")})` : ""
        rows.push(...this.db.all<{ part_id: string; session_id: string; message_id: string; role: string; t: number; snip: string; rank: number }>(
          `SELECT d.part_id AS part_id, d.session_id AS session_id, d.message_id AS message_id, d.role AS role, d.t AS t,
                  snippet(msg_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snip, bm25(msg_fts) AS rank
             FROM msg_fts JOIN docs d ON d.id = msg_fts.rowid
            WHERE msg_fts MATCH ? ${sessionFilter} ${includeFilter}
            ORDER BY rank LIMIT ?`,
          match,
          ...(opts.sessionID ? [opts.sessionID] : []),
          ...(group ?? []),
          limit * 3 + 10,
        ))
      }
      rows.sort((a, b) => a.rank - b.rank)
      const seen = new Set<string>()
      return rows.filter((row) => (seen.has(row.part_id) ? false : (seen.add(row.part_id), true)))
    }
    const and = toMatchQuery(query, "and")
    if (!and) return []
    let rows = run(and)
    if (!rows.length) {
      const or = toMatchQuery(query, "or")
      if (or && or !== and) rows = run(or)
    }
    const hits: SearchHit[] = []
    for (const r of rows) {
      if (opts.excludeSessions?.has(r.session_id)) continue
      hits.push({ sessionID: r.session_id, messageID: r.message_id, role: r.role, snippet: r.snip, rank: r.rank, time: r.t })
      if (hits.length >= limit) break
    }
    return hits
  }

  /** Remove the file (the `wipe` command does the same by path). */
  static drop(file: string) {
    for (const s of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(file + s)
      } catch {}
    }
  }
}
