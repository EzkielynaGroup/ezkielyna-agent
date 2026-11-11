// Gate: FTS5 search p95 <= 50 ms at 100k messages; lazy index build <= 5 s per 100k.
// Run: nice -n 10 bun test/ezk/bench/search-bench.ts [messages=100000]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SearchIndex } from "../../../src/ezk/search/fts"
import { insertMessage, makeCorpus, makeSource } from "../fixtures-search"

const N = Number(process.argv[2] ?? 100_000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-fts-bench-"))
try {
  const c = makeCorpus(42)
  const src = await makeSource(path.join(dir, "src.db"))
  let t0 = performance.now()
  src.transaction(() => {
    for (let i = 0; i < N; i++) insertMessage(src, { session: `s${i % 800}`, msg: `m${i}`, part: `p${i}`, role: i % 2 ? "assistant" : "user", text: c.text(40 + Math.floor(c.rnd() * 80)), t: i })
  })
  console.log(`source ${N} messages generated in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const idx = await SearchIndex.open(path.join(dir, "ezk", "search.db"))
  t0 = performance.now()
  const r = idx.sync(src, { batch: 5000 })
  const build = (performance.now() - t0) / 1000
  console.log(`lazy index build: ${r.indexed} docs in ${build.toFixed(2)} s (gate <= ${(5 * N) / 100_000} s)`)
  console.log(`index size ${(fs.statSync(idx.file).size / 1e6).toFixed(0)} MB, source ${(fs.statSync(path.join(dir, "src.db")).size / 1e6).toFixed(0)} MB`)

  const times: number[] = []
  const queries: string[] = []
  for (let i = 0; i < 600; i++) {
    const n = 1 + (i % 3)
    queries.push(Array.from({ length: n }, () => c.word()).join(" "))
  }
  for (const q of queries.slice(0, 50)) idx.search(q) // warm
  for (const q of queries) {
    const t = performance.now()
    idx.search(q, { limit: 8 })
    times.push(performance.now() - t)
  }
  // incremental sync with nothing new (what the tool does at most every 20 s)
  const tn = performance.now()
  idx.sync(src, { batch: 5000 })
  const noop = performance.now() - tn
  times.sort((a, b) => a - b)
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))]!
  console.log(`search over ${N} messages, ${times.length} queries: p50 ${pct(0.5).toFixed(2)} ms, p95 ${pct(0.95).toFixed(2)} ms, p99 ${pct(0.99).toFixed(2)} ms, max ${times.at(-1)!.toFixed(2)} ms`)
  console.log(`no-op incremental sync: ${noop.toFixed(1)} ms`)
  console.log(pct(0.95) <= 50 ? "GATE search p95 <= 50 ms: PASS" : "GATE search p95 <= 50 ms: FAIL")
  idx.close()
  src.close()
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
