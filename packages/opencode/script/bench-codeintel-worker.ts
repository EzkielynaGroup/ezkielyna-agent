import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { codeIntel } from "../src/plugin/ezk/codeintel"

const base = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-codeindex-worker-bench-"))
const data = path.join(base, "data")
const processRSS = (pid: number) => {
  try {
    const value = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()
    return Number(value) * 1024
  } catch {
    return 0
  }
}

function createCorpus(name: string, count: number) {
  const root = path.join(base, name)
  for (let i = 0; i < count; i++) {
    const dir = path.join(root, "src", `group-${String(i % 50).padStart(2, "0")}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `module-${String(i).padStart(5, "0")}.ts`),
      `/** Indexed benchmark symbol ${i}. */\nexport function BenchSymbol${String(i).padStart(5, "0")}(value: number): number {\n  return value + ${i}\n}\n`,
    )
  }
  return root
}

function p95(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0
}

let activeChildPid: number | undefined
const makeService = () => codeIntel(data, { resyncMs: 60 * 60_000, onWorkerSpawn: (pid) => (activeChildPid = pid) })
let service = makeService()
const coreRoot = path.resolve(import.meta.dir, "../../core")
const corpora = [
  { name: "synthetic-1k", root: createCorpus("synthetic-1k", 1_000), query: "BenchSymbol00999" },
  { name: "synthetic-10k", root: createCorpus("synthetic-10k", 10_000), query: "BenchSymbol09999" },
  { name: "packages-core", root: coreRoot, query: "CodeIndex" },
]

try {
  const measurements = []
  for (const corpus of corpora) {
    activeChildPid = undefined
    let mainPeak = 0
    let childPeak = 0
    const before = process.memoryUsage.rss()
    const sample = () => {
      mainPeak = Math.max(mainPeak, process.memoryUsage.rss())
      if (activeChildPid) childPeak = Math.max(childPeak, processRSS(activeChildPid))
    }
    const interval = setInterval(sample, 125)
    const start = performance.now()
    const synced = await service.sync(corpus.root, 10 * 60_000, "bench-codeintel")
    const buildMs = Math.round(performance.now() - start)
    if (!synced.index || !synced.result?.done) {
      clearInterval(interval)
      throw new Error(`Index did not finish for ${corpus.name}: ${JSON.stringify(synced)}`)
    }

    const queries = [corpus.query, corpus.query.replace(/(\D)(\d)/g, "$1 $2"), "function number", "group module", "BenchSymbol"]
    const latencies: number[] = []
    for (let i = 0; i < 300; i++) {
      const query = queries[i % queries.length]!
      const t0 = performance.now()
      synced.index.search(query)
      latencies.push(performance.now() - t0)
      if (i % 25 === 0) sample()
    }
    clearInterval(interval)
    sample()
    const mainRssAfterQueries = process.memoryUsage.rss()
    const indexBytes = synced.index.stats().bytes
    await service.close()
    const mainRssAfterClose = process.memoryUsage.rss()
    measurements.push({
      corpus: corpus.name,
      files: synced.result.files,
      parsed: synced.result.parsed,
      buildMs,
      indexBytes,
      mainRssBefore: before,
      mainRssPeak: mainPeak,
      mainRssAfterQueries,
      mainRssAfterClose,
      mainDeltaPeak: mainPeak - before,
      childPeakRss: childPeak,
      queryP95Ms: Number(p95(latencies).toFixed(3)),
    })
    process.stdout.write(`${JSON.stringify(measurements.at(-1))}\n`)
    service = makeService()
  }
  await Bun.write(path.join(base, "measurements.json"), JSON.stringify(measurements, null, 2))
} finally {
  await service.close()
  fs.rmSync(base, { recursive: true, force: true })
}
