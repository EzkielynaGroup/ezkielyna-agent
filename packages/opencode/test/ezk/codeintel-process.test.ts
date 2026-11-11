import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCodeIndexWorkerProcess, runCodeIndexWorkerWithRetry } from "../../src/ezk/codeintel-process"
import { codeIntel } from "../../src/plugin/ezk/codeintel"
import { indexFile } from "@opencode-ai/core/ezk/codeintel/index"

const dirs: string[] = []
const workerSource = `
import fs from "node:fs"
const input = JSON.parse(process.argv[2])
if (input.mode === "crash-once" || input.mode === "crash-always") {
  const count = Number(fs.existsSync(input.attempts) ? fs.readFileSync(input.attempts, "utf8") : "0") + 1
  fs.writeFileSync(input.attempts, String(count))
  if (input.mode === "crash-always" || count === 1) process.exit(17)
}
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n")
if (input.mode === "hold") setInterval(() => {}, 1000)
else {
  process.stdout.write(JSON.stringify({ type: "progress", parsed: 1, total: 1 }) + "\\n")
  process.stdout.write(JSON.stringify({ type: "result", result: { files: 1, parsed: 1, removed: 0, done: true, ms: 2, source: "walk" } }) + "\\n")
}
`

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-codeindex-worker-"))
  dirs.push(root)
  const worker = path.join(root, "worker.mjs")
  fs.writeFileSync(worker, workerSource)
  return { root, worker }
}

function options(worker: string, mode: string, extra: Record<string, unknown> = {}) {
  const payload = { mode, ...extra }
  return {
    command: {
      command: process.execPath,
      args: ["--smol", "run", worker, JSON.stringify(payload)],
    },
    timeoutMs: 5_000,
  }
}

function input(root: string) {
  return { file: path.join(root, "index.db"), root, git: false, batchSize: 24 }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("code index child process", () => {
  test("reports progress and a successful result over its bounded protocol", async () => {
    const { root, worker } = fixture()
    const messages: unknown[] = []
    const result = await runCodeIndexWorkerProcess(input(root), { onMessage: (message) => messages.push(message) }, options(worker, "ok")).promise
    expect(result).toMatchObject({ files: 1, parsed: 1, done: true })
    expect(messages).toEqual([
      { type: "ready" },
      { type: "progress", parsed: 1, total: 1 },
      { type: "result", result },
    ])
  })

  test("retries a crashed child exactly once", async () => {
    const { root, worker } = fixture()
    const attempts = path.join(root, "attempts")
    const result = await runCodeIndexWorkerWithRetry(input(root), {}, options(worker, "crash-once", { attempts }))
    expect(result).toMatchObject({ done: true })
    expect(fs.readFileSync(attempts, "utf8")).toBe("2")
  })

  test("surfaces the last crash after one retry", async () => {
    const { root, worker } = fixture()
    const attempts = path.join(root, "attempts")
    await expect(runCodeIndexWorkerWithRetry(input(root), {}, options(worker, "crash-always", { attempts }))).rejects.toThrow(
      "Code index worker failed",
    )
    expect(fs.readFileSync(attempts, "utf8")).toBe("2")
  })

  test("cancels a live child and reports a timeout clearly", async () => {
    const { root, worker } = fixture()
    const child = runCodeIndexWorkerProcess(input(root), {}, options(worker, "hold"))
    await Bun.sleep(100)
    child.cancel()
    await expect(child.promise).rejects.toMatchObject({ name: "AbortError" })

    const timed = runCodeIndexWorkerProcess(input(root), {}, { ...options(worker, "hold"), timeoutMs: 50 })
    await expect(timed.promise).rejects.toThrow("timed out after 50 ms")
  })

  test("uses a separate process and incrementally updates the per-project data index", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-codeindex-incremental-"))
    dirs.push(base)
    const root = path.join(base, "project")
    const data = path.join(base, "data")
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    const source = path.join(root, "src", "index.ts")
    fs.writeFileSync(source, "export function beforeWorker() {}\n")
    const workerPids: number[] = []
    const service = codeIntel(data, { resyncMs: 0, onWorkerSpawn: (pid) => pid && workerPids.push(pid) })
    try {
      const initial = await service.search(root, "beforeWorker", 20, "session-ci")
      expect(initial.hits.map((hit) => hit.name)).toContain("beforeWorker")
      expect(workerPids[0]).toBeDefined()
      expect(workerPids[0]).not.toBe(process.pid)
      expect(fs.existsSync(indexFile(data, root))).toBe(true)

      fs.writeFileSync(source, "export function afterWorker() {}\n")
      fs.utimesSync(source, new Date(), new Date(Date.now() + 5000))
      const partial = await service.sync(root, 1, "session-ci")
      expect(partial.result).toBeUndefined()
      expect(partial.index?.search("beforeWorker").map((hit) => hit.name)).toContain("beforeWorker")

      const updated = await service.search(root, "afterWorker", 20, "session-ci")
      expect(updated.hits.map((hit) => hit.name)).toContain("afterWorker")
      expect(updated.result?.parsed).toBe(1)
      expect(workerPids).toHaveLength(2)
    } finally {
      await service.close()
    }
  }, 30_000)
})
