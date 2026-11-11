import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadFlags } from "../../src/ezk/flags"
import { gitHead, listProjectFiles } from "../../src/ezk/codeintel/files"
import { CodeIndex, formatCodeHits, indexFile, splitIdentifier } from "../../src/ezk/codeintel/index"
import { buildRepoMap, mentionedFiles, mentionedIdentifiers, pagerank, rankDefinitions } from "../../src/ezk/codeintel/repomap"
import { extractTags } from "../../src/ezk/codeintel/tags"
import { grammarFor } from "../../src/ezk/treesitter/loader"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-codeintel-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function write(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
}

function gitInit(root: string) {
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"], { cwd: root })
}

describe("tree-sitter loader", () => {
  test("maps extensions, skips declaration files", () => {
    expect(grammarFor("a/b.ts")).toBe("typescript")
    expect(grammarFor("a/b.tsx")).toBe("tsx")
    expect(grammarFor("x.mjs")).toBe("javascript")
    expect(grammarFor("x.PY")).toBe("python")
    expect(grammarFor("main.go")).toBe("go")
    expect(grammarFor("lib.rs")).toBe("rust")
    expect(grammarFor("A.java")).toBe("java")
    expect(grammarFor("types.d.ts")).toBeUndefined()
    expect(grammarFor("README.md")).toBeUndefined()
  })

  test("lazy: importing loads nothing; parsing Python loads only Python", () => {
    const script = `
      const loader = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/ezk/treesitter/loader.ts"))})
      const tags = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/ezk/codeintel/tags.ts"))})
      const before = loader.loadedGrammars()
      await tags.extractTags("python", "def f():\\n  pass\\n")
      console.log(JSON.stringify({ before, after: loader.loadedGrammars() }))`
    const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" })
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ before: [], after: ["python"] })
  })
})

describe("tags", () => {
  test("TypeScript: kinds, signature up to the body, JSDoc, references", async () => {
    const t = (await extractTags(
      "typescript",
      `/** Load the user. */\nexport async function loadUser(id: string,\n  opts?: Opts): Promise<User> {\n  return fetchUser(id)\n}\nexport class Store extends Base {\n  get(k: string): number { return 1 }\n}\nexport interface Opts { a: number }\nexport type ID = string\nconst helper = (x: number) => x * 2\nnew Store()\n`,
    ))!
    expect(t.defs.map((d) => [d.name, d.kind, d.line])).toEqual([
      ["loadUser", "function", 2],
      ["Store", "class", 6],
      ["get", "method", 7],
      ["Opts", "type", 9],
      ["ID", "type", 10],
      ["helper", "function", 11],
    ])
    expect(t.defs[0]!.signature).toBe("export async function loadUser(id: string, opts?: Opts): Promise<User>")
    expect(t.defs[0]!.doc).toBe("Load the user.")
    expect(t.refs.get("fetchUser")).toBe(1)
    expect(t.refs.get("Store")).toBe(1) // the class name itself is a definition, `new Store()` is the reference
    expect(t.refs.get("Opts")).toBe(1)
  })

  test("Python methods and docstrings, Go/Rust/Java doc comments", async () => {
    const py = (await extractTags("python", `class Repo:\n    """A repo."""\n    @property\n    def name(self):\n        return helper(self)\n\ndef helper(x):\n    '''Help.'''\n    return x\n`))!
    expect(py.defs.map((d) => [d.name, d.kind, d.doc])).toEqual([
      ["Repo", "class", "A repo."],
      ["name", "method", ""],
      ["helper", "function", "Help."],
    ])
    expect(py.defs[1]!.signature).toBe("def name(self)")
    const go = (await extractTags("go", `package main\n// Add adds.\nfunc Add(a, b int) int { return a + b }\ntype Server struct { x int }\nfunc (s *Server) Run() error { return nil }\n`))!
    expect(go.defs.map((d) => [d.name, d.kind, d.signature, d.doc])).toEqual([
      ["Add", "function", "func Add(a, b int) int", "Add adds."],
      ["Server", "type", "type Server struct", ""],
      ["Run", "method", "func (s *Server) Run() error", ""],
    ])
    const rs = (await extractTags("rust", `/// A point.\npub struct Point { x: i32 }\nimpl Point {\n    pub fn new(x: i32) -> Self { Point { x } }\n}\ntrait Shape { fn area(&self) -> f64; }\n`))!
    expect(rs.defs.map((d) => [d.name, d.kind])).toEqual([
      ["Point", "class"],
      ["new", "method"],
      ["Shape", "type"],
      ["area", "method"],
    ])
    expect(rs.defs[0]!.doc).toBe("A point.")
    expect(rs.defs[3]!.signature).toBe("fn area(&self) -> f64")
    const java = (await extractTags("java", `/** Doc. */\npublic class Hello implements Runnable {\n  /** run it */\n  public void run() { new Thread(); }\n}\n`))!
    expect(java.defs.map((d) => [d.name, d.kind, d.doc])).toEqual([
      ["Hello", "class", "Doc."],
      ["run", "method", "run it"],
    ])
    expect(java.refs.get("Thread")).toBe(1) // matched by two patterns, counted once
  })

  test("arrow functions count as definitions only at module scope", async () => {
    const t = (await extractTags("typescript", `export const top = (a: number) => a
const local = () => 1
function outer() {
  const nested = () => 2
  return nested()
}
`))!
    expect(t.defs.map((d) => d.name)).toEqual(["top", "local", "outer"])
  })

  test("JavaScript and TSX parse with their own grammars; broken code still yields what parses", async () => {
    const js = (await extractTags("javascript", `// adds\nfunction add(a, b) { return a + b }\nclass Foo { bar() { add(1, 2) } }\n`))!
    expect(js.defs.map((d) => d.name)).toEqual(["add", "Foo", "bar"])
    expect(js.defs[0]!.doc).toBe("adds")
    const tsx = (await extractTags("tsx", `export function App(props: Props) { return <div onClick={() => go()}>hi</div> }\n`))!
    expect(tsx.defs.map((d) => d.name)).toEqual(["App"])
    const broken = (await extractTags("typescript", `function ok() {}\nfunction broken( {\n`))!
    expect(broken.defs.map((d) => d.name)).toContain("ok")
  })
})

describe("file listing", () => {
  test("git: tracked + untracked, .gitignore respected", async () => {
    write(dir, { "a.ts": "", "src/b.py": "", ".gitignore": "ignored/\n*.log\n", "ignored/c.ts": "", "x.log": "" })
    gitInit(dir)
    write(dir, { "new.go": "" })
    const list = await listProjectFiles(dir)
    expect(list.source).toBe("git")
    expect(list.files).toEqual([".gitignore", "a.ts", "new.go", "src/b.py"])
  })

  test("untrusted project: no git process, the walk answers", async () => {
    write(dir, { "a.ts": "", ".gitignore": "x/\n", "x/y.ts": "" })
    gitInit(dir)
    const list = await listProjectFiles(dir, undefined, false)
    expect(list.source).toBe("walk")
    expect(list.files).toEqual([".gitignore", "a.ts"])
  })

  test("HEAD is read from the .git files: loose ref, packed refs, detached, linked worktree", () => {
    write(dir, { "a.ts": "" })
    expect(gitHead(dir)).toBeUndefined()
    gitInit(dir)
    const rev = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim()
    expect(gitHead(dir)).toBe(rev(dir))
    execFileSync("git", ["pack-refs", "--all"], { cwd: dir })
    expect(gitHead(dir)).toBe(rev(dir))
    execFileSync("git", ["checkout", "-q", "--detach"], { cwd: dir })
    expect(gitHead(dir)).toBe(rev(dir))
    const wt = path.join(dir, "..", path.basename(dir) + "-wt")
    execFileSync("git", ["worktree", "add", "-q", "-b", "side", wt], { cwd: dir })
    try {
      expect(gitHead(wt)).toBe(rev(wt))
    } finally {
      fs.rmSync(wt, { recursive: true, force: true })
    }
  })

  test("no git: bounded walk with the root .gitignore and dependency folders skipped", async () => {
    write(dir, { "a.ts": "", ".gitignore": "gen/\n", "gen/x.ts": "", "node_modules/m/i.js": "", "lib/y.rs": "" })
    const list = await listProjectFiles(dir)
    expect(list.source).toBe("walk")
    expect(list.files).toEqual([".gitignore", "a.ts", "lib/y.rs"])
    expect((await listProjectFiles(dir, 1)).truncated).toBe(true)
  })
})

describe("CodeIndex", () => {
  const project = () => {
    const root = path.join(dir, "proj")
    write(root, {
      "src/auth/session-store.ts": `/** Persist login sessions in redis. */\nexport class SessionStore {\n  /** Remove expired sessions. */\n  purgeExpired(now: number): number { return 0 }\n}\n`,
      "src/user.ts": `export function getUserName(id: string): string { return new SessionStore().purgeExpired(1) ? id : "" }\n`,
      "tools/report.py": `def render_report(rows):\n    """Render the monthly billing report."""\n    return rows\n`,
      "docs/guide.md": "# Guide\n",
      "vendor/lib/dep.go": "package lib\nfunc VendoredHelper() {}\n",
      ".gitignore": "dist/\n",
      "dist/bundle.js": "function shouldNotBeIndexed() {}\n",
    })
    gitInit(root)
    return root
  }

  test("lazy file per project (0600), exact names, split words, doc comments, paths", async () => {
    const root = project()
    const file = indexFile(path.join(dir, "data"), root)
    expect(file).toBe(indexFile(path.join(dir, "data"), root + "/"))
    expect(file).not.toBe(indexFile(path.join(dir, "data"), path.join(dir, "other")))
    expect(fs.existsSync(file)).toBe(false)
    const idx = await CodeIndex.open(file, root)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const r = await idx.sync()
    expect(r).toMatchObject({ files: 6, parsed: 6, removed: 0, done: true, source: "git" })

    expect(idx.search("getUserName")[0]).toEqual({ path: "src/user.ts", line: 1, kind: "function", name: "getUserName", signature: "export function getUserName(id: string): string" })
    expect(idx.search("user name")[0]!.name).toBe("getUserName") // camelCase split
    expect(idx.search("purge expired")[0]!.name).toBe("purgeExpired")
    expect(idx.search("redis login")[0]!.name).toBe("SessionStore") // doc comment
    expect(idx.search("billing report")[0]!.name).toBe("render_report") // Python docstring
    expect(idx.search("session store")[0]!.name).toBe("SessionStore")
    expect(idx.search("guide").map((h) => [h.path, h.kind])).toEqual([["docs/guide.md", "file"]]) // non-code: path only
    expect(idx.search("shouldNotBeIndexed")).toEqual([]) // .gitignore
    expect(idx.search("VendoredHelper")).toEqual([]) // vendored: path only
    expect(idx.search("vendor dep")[0]!.path).toBe("vendor/lib/dep.go")
    expect(idx.search('" OR NEAR(')).toEqual([]) // FTS syntax is neutralised
    expect(idx.search("store", 1)).toHaveLength(1)
    expect(formatCodeHits(idx.search("getUserName"))).toBe("src/user.ts:1  function  getUserName  export function getUserName(id: string): string")
    expect(idx.stats().defs).toBe(4)
    idx.close()
  })

  test("main-process reader is read-only and can query worker-written results", async () => {
    const root = project()
    const file = indexFile(path.join(dir, "data"), root)
    const writer = await CodeIndex.open(file, root)
    await writer.sync()
    const reader = await CodeIndex.openReadOnly(file, root)
    expect(reader.search("purgeExpired")[0]?.name).toBe("purgeExpired")
    expect(() => reader.setMeta("should_not_write", "true")).toThrow()
    reader.close()
    writer.close()
  })

  test("incremental by mtime: unchanged files are skipped, edits re-parsed, deletions dropped", async () => {
    const root = project()
    const idx = await CodeIndex.open(indexFile(path.join(dir, "data"), root), root)
    await idx.sync()
    expect((await idx.sync()).parsed).toBe(0)
    write(root, { "src/user.ts": `export function getDisplayName(id: string) { return id }\n` })
    fs.utimesSync(path.join(root, "src/user.ts"), new Date(), new Date(Date.now() + 5000))
    fs.rmSync(path.join(root, "tools/report.py"))
    const r = await idx.sync()
    expect(r).toMatchObject({ parsed: 1, removed: 1, done: true })
    expect(idx.search("getUserName").filter((h) => h.name === "getUserName")).toEqual([])
    expect(idx.search("getDisplayName")[0]!.path).toBe("src/user.ts")
    expect(idx.search("render_report")).toEqual([])
    idx.close()
  })

  test("symlinked files are not followed (they could point outside the project)", async () => {
    const root = path.join(dir, "linked")
    write(root, { "real.ts": "export function insideProject() {}\n" })
    write(dir, { "outside/secret.ts": "export function outsideProject() {}\n" })
    fs.symlinkSync(path.join(dir, "outside/secret.ts"), path.join(root, "link.ts"))
    gitInit(root)
    const idx = await CodeIndex.open(indexFile(path.join(dir, "data"), root), root)
    await idx.sync()
    expect(idx.search("insideProject")[0]!.path).toBe("real.ts")
    expect(idx.search("outsideProject").map((h) => h.path)).not.toContain("link.ts")
    expect(idx.graph().files).toEqual(["real.ts"])
    idx.close()
  })

  test("time budget: a sync can stop early and the next one continues", async () => {
    const root = path.join(dir, "big")
    write(root, Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`m${i}.ts`, `export function fn${i}() {}\n`])))
    gitInit(root)
    const idx = await CodeIndex.open(indexFile(path.join(dir, "data"), root), root)
    const first = await idx.sync({ budgetMs: 0 })
    expect(first.done).toBe(false)
    expect(first.parsed).toBe(0)
    const second = await idx.sync()
    expect(second).toMatchObject({ parsed: 450, done: true })
    expect(idx.search("fn449")[0]!.path).toBe("m449.ts")
    idx.close()
  })

  test("graph rows feed the repo map", async () => {
    const root = project()
    const idx = await CodeIndex.open(indexFile(path.join(dir, "data"), root), root)
    await idx.sync()
    const g = idx.graph()
    expect(g.defs.find((d) => d.name === "purgeExpired")).toMatchObject({ file: "src/auth/session-store.ts", kind: "method" })
    expect(g.refs).toContainEqual({ file: "src/user.ts", name: "SessionStore", n: 1 })
    expect(g.files).toContain("docs/guide.md")
    idx.close()
  })
})

describe("repo map", () => {
  // core.ts is used by everyone; feature.ts uses helpers; chat about feature.ts should pull in helpers.ts.
  const graph = {
    files: ["core.ts", "a.ts", "b.ts", "feature.ts", "helpers.ts", "lonely.ts"],
    defs: [
      { file: "core.ts", name: "coreRuntime", line: 1, kind: "function" as const, signature: "export function coreRuntime()" },
      { file: "helpers.ts", name: "formatInvoiceLine", line: 3, kind: "function" as const, signature: "export function formatInvoiceLine(x: Line)" },
      { file: "feature.ts", name: "renderInvoice", line: 2, kind: "function" as const, signature: "export function renderInvoice()" },
      { file: "lonely.ts", name: "unused", line: 1, kind: "function" as const, signature: "function unused()" },
    ],
    refs: [
      { file: "a.ts", name: "coreRuntime", n: 3 },
      { file: "b.ts", name: "coreRuntime", n: 2 },
      { file: "feature.ts", name: "coreRuntime", n: 1 },
      { file: "feature.ts", name: "formatInvoiceLine", n: 4 },
    ],
  }

  test("pagerank sums to 1 and follows the personalisation", () => {
    // x=0 -> y=1 -> z=2
    const flat = pagerank(3, [0, 1], [1, 2], [1, 1])
    expect(flat.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(flat[2]!).toBeGreaterThan(flat[0]!)
    const personal = pagerank(3, [0, 1], [1, 2], [1, 1], new Float64Array([1, 0, 0]))
    expect(personal.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(personal[0]!).toBeGreaterThan(flat[0]!)
  })

  test("names defined in more than 20 files add no edges", () => {
    const generic = {
      files: [],
      defs: Array.from({ length: 21 }, (_, i) => ({ file: `d${i}.ts`, name: "get", line: 1, kind: "function" as const, signature: "get()" })),
      refs: [{ file: "user.ts", name: "get", n: 50 }],
    }
    expect(rankDefinitions({ graph: generic }).filter((d) => d.name === "get")).toEqual([])
  })

  test("the widely used definition ranks first; chat files pull in their neighbours", () => {
    expect(rankDefinitions({ graph })[0]!.name).toBe("coreRuntime")
    const personal = rankDefinitions({ graph, chatFiles: ["feature.ts"] })
    expect(personal[0]!.name).toBe("formatInvoiceLine")
  })

  test("renders `path:` blocks within the token budget", () => {
    const map = buildRepoMap({ graph, chatFiles: ["feature.ts"] })
    expect(map.text.split("\n")[0]).toBe("helpers.ts:")
    expect(map.text).toContain("  3: export function formatInvoiceLine(x: Line)")
    expect(map.files).toContain("core.ts")
    const tiny = buildRepoMap({ graph, chatFiles: ["feature.ts"], maxTokens: 15 })
    expect(tiny.tokens).toBeLessThanOrEqual(15)
    expect(tiny.files).toEqual(["helpers.ts"])
    expect(buildRepoMap({ graph: { files: [], defs: [], refs: [] } }).text).toBe("")
  })

  test("mentioned files and identifiers", () => {
    expect([...mentionedFiles("please fix src/auth/session-store.ts and user.ts", ["src/auth/session-store.ts", "src/user.ts", "lib/user.ts"])]).toEqual(["src/auth/session-store.ts"])
    expect([...mentionedFiles("look at helpers.ts", ["x/helpers.ts"])]).toEqual(["x/helpers.ts"])
    expect(mentionedIdentifiers("rename getUserName and fix it")).toEqual(new Set(["rename", "getUserName"]))
  })

  test("splitIdentifier", () => {
    expect(splitIdentifier("getUserName")).toBe("get user name")
    expect(splitIdentifier("HTTPServer")).toBe("http server")
    expect(splitIdentifier("snake_case-name")).toBe("snake case name")
  })
})

describe("flags", () => {
  test("code search and repo map are off by default; config and EZK_FEATURES turn them on", () => {
    const off = loadFlags([], {})
    expect(off.codesearch.enabled).toBe(false)
    expect(off.repomap).toEqual({ enabled: false, tokens: 1024, minFiles: 200 })
    const on = loadFlags([], { EZK_FEATURES: "+codesearch,+repomap" })
    expect(on.codesearch.enabled).toBe(true)
    expect(on.repomap.enabled).toBe(true)
    fs.writeFileSync(path.join(dir, "ezkielyna.json"), JSON.stringify({ ezk: { repomap: { enabled: true, tokens: 2048, minFiles: 50 } } }))
    expect(loadFlags([dir], {}).repomap).toEqual({ enabled: true, tokens: 2048, minFiles: 50 })
    expect(loadFlags([dir], { EZK_FEATURES: "-repomap" }).repomap.enabled).toBe(false)
  })
})

describe("import references", () => {
  test("imported names count as references in every language that imports symbols", async () => {
    const refs = async (id: Parameters<typeof extractTags>[0], src: string) => [...(await extractTags(id, src))!.refs.keys()]
    expect(await refs("typescript", `import Def, { formatLine } from "./f"\nexport const x = [1].map(formatLine)\n`)).toEqual(expect.arrayContaining(["Def", "formatLine"]))
    expect(await refs("javascript", `import { a } from "b"\n`)).toEqual(["a"])
    expect(await refs("python", `from pkg.mod import helper, other as o\n`)).toEqual(expect.arrayContaining(["helper", "other"]))
    expect(await refs("rust", `use crate::geo::{Point, area};\nuse std::fmt::Display;\n`)).toEqual(expect.arrayContaining(["Point", "area", "Display"]))
    expect(await refs("java", `import com.acme.Billing;\nclass A {}\n`)).toEqual(["Billing"])
  })
})
