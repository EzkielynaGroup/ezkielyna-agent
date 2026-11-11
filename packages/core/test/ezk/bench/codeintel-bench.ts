// Code index (T6) + repo map (T7) measurements: cold build, index size, peak RSS, no-op and incremental resync,
// query p50/p95, repo-map build time and RSS.
// Run from packages/core:
//   nice -n 10 bun test/ezk/bench/codeintel-bench.ts synthetic 10000
//   nice -n 10 bun test/ezk/bench/codeintel-bench.ts repo /path/to/checkout
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CodeIndex } from "../../../src/ezk/codeintel/index"
import { buildRepoMap } from "../../../src/ezk/codeintel/repomap"
import { loadedGrammars } from "../../../src/ezk/treesitter/loader"

const [mode = "synthetic", arg = "1000"] = process.argv.slice(2)
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-codeintel-bench-"))

const mb = (n: number) => (n / 1e6).toFixed(1)
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))]!

function sampler() {
  let peak = process.memoryUsage().rss
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20)
  return () => {
    clearInterval(timer)
    return Math.max(peak, process.memoryUsage().rss)
  }
}

try {
  const root = mode === "repo" ? path.resolve(arg) : synthetic(Number(arg))
  const label = mode === "repo" ? path.basename(root) : `synthetic-${arg}`
  Bun.gc(true)
  const base = process.memoryUsage().rss
  const idx = await CodeIndex.open(path.join(work, "index.db"), root)

  let stop = sampler()
  let t0 = performance.now()
  const build = await idx.sync()
  const buildMs = performance.now() - t0
  const buildPeak = stop()
  idx.close()
  // Size after the WAL is folded back in (what stays on disk between sessions).
  const reopened = await CodeIndex.open(path.join(work, "index.db"), root)
  const stats = reopened.stats()

  t0 = performance.now()
  const noop = await reopened.sync()
  const noopMs = performance.now() - t0

  const sample = reopened.graph()
  const touched = sample.files.filter((f) => /\.(ts|tsx|js|py|go|rs|java)$/.test(f)).slice(0, 10)
  const later = new Date(Date.now() + 10_000)
  for (const f of touched) fs.utimesSync(path.join(root, f), later, later)
  t0 = performance.now()
  const incr = await reopened.sync()
  const incrMs = performance.now() - t0

  // Queries: exact identifiers, split words, a path word plus an identifier word.
  const names = sample.defs.map((d) => d.name)
  const pick = (i: number) => names[(i * 7919) % names.length] ?? "main"
  const queries = Array.from({ length: 300 }, (_, i) => {
    const name = pick(i)
    if (i % 3 === 0) return name
    if (i % 3 === 1) return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase()
    const file = sample.files[(i * 104729) % sample.files.length] ?? ""
    return `${file.split("/").at(-2) ?? ""} ${name.slice(0, 5)}`
  })
  const times: number[] = []
  let empty = 0
  for (const q of queries) {
    const s = performance.now()
    if (!reopened.search(q).length) empty++
    times.push(performance.now() - s)
  }

  Bun.gc(true)
  stop = sampler()
  t0 = performance.now()
  const graph = reopened.graph()
  const graphMs = performance.now() - t0
  const chat = graph.files.filter((f) => /\.(ts|py|go|rs|java)$/.test(f)).slice(0, 2)
  t0 = performance.now()
  const map = buildRepoMap({ graph, chatFiles: chat, maxTokens: 1024 })
  const mapMs = performance.now() - t0
  const mapPeak = stop()
  reopened.close()

  console.log(
    JSON.stringify({
      label,
      files: build.files,
      defs: stats.defs,
      refs: graph.refs.length,
      grammars: loadedGrammars(),
      buildS: +(buildMs / 1000).toFixed(2),
      indexMB: +mb(stats.bytes),
      baseRssMB: +mb(base),
      buildPeakRssMB: +mb(buildPeak),
      buildRssDeltaMB: +mb(buildPeak - base),
      noopResyncMs: Math.round(noopMs),
      noopParsed: noop.parsed,
      incrResyncMs: Math.round(incrMs),
      incrParsed: incr.parsed,
      queryP50Ms: +pct(times, 50).toFixed(2),
      queryP95Ms: +pct(times, 95).toFixed(2),
      queryMaxMs: +Math.max(...times).toFixed(2),
      emptyQueries: empty,
      graphLoadMs: Math.round(graphMs),
      mapMs: Math.round(mapMs),
      mapTokens: map.tokens,
      mapFiles: map.files.length,
      mapPeakRssMB: +mb(mapPeak),
    }),
  )
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

// Deterministic multi-language project: ~75% TS, 10% Python, 7% Go, 5% Rust, 3% Java; each file defines a handful
// of camelCase/snake_case symbols, imports and calls symbols from three other files, and carries ~60 lines of body.
function synthetic(n: number) {
  const root = path.join(work, "project")
  let seed = 42
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const verbs = ["parse", "render", "load", "save", "format", "validate", "compute", "build", "resolve", "merge", "fetch", "apply"]
  const nouns = ["Invoice", "Session", "User", "Config", "Report", "Token", "Order", "Cache", "Route", "Payment", "Schema", "Event", "Ledger", "Queue"]
  const name = (i: number, j: number) => `${verbs[(i + j * 5) % verbs.length]}${nouns[(i * 3 + j) % nouns.length]}${i}x${j}`
  const filler = (k: number) => Array.from({ length: k }, (_, i) => `  const v${i} = values[${i}] ?? ${i} // step ${i} keeps the line realistic`).join("\n")
  const langs = Array.from({ length: n }, (_, i) => {
    const r = (i * 37) % 100
    return r < 75 ? "ts" : r < 85 ? "py" : r < 92 ? "go" : r < 97 ? "rs" : "java"
  })
  for (let i = 0; i < n; i++) {
    const dir = path.join(root, `pkg${Math.floor(i / 100)}`)
    fs.mkdirSync(dir, { recursive: true })
    const deps = [0, 1, 2].map(() => Math.floor(rnd() * n))
    const calls = deps.map((d) => name(d, d % 4))
    const ext = langs[i]!
    const file = path.join(dir, `mod${i}.${ext}`)
    const own = [0, 1, 2, 3].map((j) => name(i, j))
    if (ext === "ts")
      fs.writeFileSync(file, `${calls.map((c, k) => `import { ${c} } from "../pkg${Math.floor(deps[k]! / 100)}/mod${deps[k]}"`).join("\n")}\n\n/** ${own[0]} handles the ${nouns[i % nouns.length]} flow. */\nexport class ${nouns[i % nouns.length]}Service${i} {\n  ${own[1]}(values: number[]): number {\n${filler(20)}\n    return ${calls[0]}(values)\n  }\n}\n\nexport function ${own[0]}(values: number[]): number {\n${filler(20)}\n  return ${calls[1]}(values) + ${calls[2]}(values)\n}\n\nexport const ${own[2]} = (values: number[]) => values.length\nexport function ${own[3]}(values: number[]) { return ${own[0]}(values) }\n`)
    if (ext === "py")
      fs.writeFileSync(file, `from pkg.mod import ${calls.join(", ")}\n\nclass ${nouns[i % nouns.length]}Handler${i}:\n    """Handles ${own[0]}."""\n    def ${own[1]}(self, values):\n${Array.from({ length: 15 }, (_, k) => `        v${k} = values[${k}] if len(values) > ${k} else ${k}  # step ${k}`).join("\n")}\n        return ${calls[0]}(values)\n\ndef ${own[0]}(values):\n    return ${calls[1]}(values) + ${calls[2]}(values)\n`)
    if (ext === "go")
      fs.writeFileSync(file, `package pkg\n\n// ${own[0]} computes things.\nfunc ${own[0]}(values []int) int {\n\treturn ${calls[0]}(values) + ${calls[1]}(values)\n}\n\ntype ${nouns[i % nouns.length]}Store${i} struct { items []int }\n\nfunc (s *${nouns[i % nouns.length]}Store${i}) ${own[1]}(values []int) int { return ${calls[2]}(values) }\n`)
    if (ext === "rs")
      fs.writeFileSync(file, `use crate::pkg::{${calls.join(", ")}};\n\n/// ${own[0]} computes things.\npub fn ${own[0]}(values: &[i32]) -> i32 { ${calls[0]}(values) + ${calls[1]}(values) }\n\npub struct ${nouns[i % nouns.length]}Item${i} { x: i32 }\n\nimpl ${nouns[i % nouns.length]}Item${i} {\n    pub fn ${own[1]}(&self) -> i32 { ${calls[2]}(&[self.x]) }\n}\n`)
    if (ext === "java")
      fs.writeFileSync(file, `package pkg;\n\n/** ${own[0]} */\npublic class Mod${i} {\n  public int ${own[0]}(int[] values) { return Lib.${calls[0]}(values) + Lib.${calls[1]}(values); }\n}\n`)
  }
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["-c", "user.email=b@b", "-c", "user.name=b", "add", "-A"], { cwd: root })
  execFileSync("git", ["-c", "user.email=b@b", "-c", "user.name=b", "commit", "-qm", "synthetic"], { cwd: root })
  return root
}
