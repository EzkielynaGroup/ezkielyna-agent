// U4 mock-gateway e2e: /ezk/context and /ezk/usage against the real server after two turns, the flag kill switch,
// and the `ezkielyna doctor` CLI (exit codes, the key never printed).
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "../ezk/harness"
import type { ContextResponse, UsageResponse } from "@opencode-ai/core/ezk/exec/contracts"

const KEY = "test-key-not-real-0123456789"
const MODEL = "deepseek-v4.1-flash"
let srv: Server | undefined
let gw: ReturnType<typeof startMockGateway> | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

test("/context breaks down the last request; /usage reports tokens, router-priced cost and the cache line", async () => {
  gw = startMockGateway({ models: { [KEY]: [MODEL] }, script: { [MODEL]: [{ ok: true, text: "one", usage: { prompt: 12_000, completion: 50 } }, { ok: true, text: "two", usage: { prompt: 13_000, completion: 60 } }] } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+statusline" }, seed: (dirs) => fs.writeFileSync(path.join(dirs.project, "AGENTS.md"), "Always answer in haiku.\n") })
  const s = await newSession(srv)
  expect(await srv.api<ContextResponse>("GET", `/ezk/context?sessionID=${s.id}`)).toEqual({ enabled: true, breakdown: null })
  await prompt(srv, s.id, "first", MODEL)
  await prompt(srv, s.id, "second", MODEL)

  const ctx = await srv.api<ContextResponse>("GET", `/ezk/context?sessionID=${s.id}`)
  if (!ctx.enabled || !ctx.breakdown) throw new Error("no breakdown")
  const b = ctx.breakdown
  expect(b.modelID).toBe(MODEL)
  expect(b.window).toBeGreaterThan(0)
  expect(b.source).toBe("measured")
  expect(Math.abs(b.used - 13_000)).toBeLessThanOrEqual(5)
  const parts = Object.fromEntries(b.rows.map((r) => [r.part, r.tokens]))
  expect(parts.system).toBeGreaterThan(0)
  expect(parts.tools).toBeGreaterThan(0)
  expect(parts.messages).toBeGreaterThan(0)

  const usage = await srv.api<UsageResponse>("GET", `/ezk/usage?sessionID=${s.id}`)
  if (!usage.enabled) throw new Error("usage off")
  expect(usage.statusline).toBe(true)
  expect(usage.report.steps).toBe(2)
  expect(usage.report.tokens.input).toBe(25_000)
  expect(usage.report.tokens.output).toBe(110)
  // router price book (static fallback for this model), not the $0 placeholder metadata
  expect(usage.report.costUSD).toBeGreaterThan(0)
  expect(usage.report.missCause).toBe("not-reported")
  expect(usage.contextPct).toBeCloseTo((13_000 / b.window) * 100, 0)
}, 120_000)

test("-diagnostics turns the routes off", async () => {
  gw = startMockGateway({ models: { [KEY]: [MODEL] } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "-diagnostics" } })
  const s = await newSession(srv)
  await prompt(srv, s.id, "hi", MODEL)
  expect(await srv.api<ContextResponse>("GET", `/ezk/context?sessionID=${s.id}`)).toEqual({ enabled: false })
  expect(await srv.api<UsageResponse>("GET", `/ezk/usage?sessionID=${s.id}`)).toEqual({ enabled: false, statusline: false })
}, 120_000)

async function doctor(key: string, extra: string[] = []) {
  gw = startMockGateway({ models: { [KEY]: [MODEL] } })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-doctor-"))
  const proc = Bun.spawn(["bun", "run", "src/index.ts", "doctor", ...extra], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OPENCODE_") && !k.startsWith("XDG_") && k !== "EZK_FEATURES")),
      HOME: dir,
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      XDG_STATE_HOME: path.join(dir, "state"),
      EZKIELYNA_BASE_URL: gw.baseURL,
      EZKIELYNA_API_KEY: key,
      EZK_LANG: "en",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  fs.rmSync(dir, { recursive: true, force: true })
  return { out, err, code }
}

test("ezkielyna doctor: healthy key exits 0 and lists models without printing the key", async () => {
  const r = await doctor(KEY)
  expect(r.code).toBe(0)
  expect(r.out).toContain("✓ API key")
  expect(r.out).toContain(`1 available: ${MODEL}`)
  expect(r.out + r.err).not.toContain(KEY)
}, 120_000)

test("ezkielyna doctor: a refused key exits 1; --json is machine-readable", async () => {
  const r = await doctor("wrong-key-0000", ["--json"])
  expect(r.code).toBe(1)
  const checks = JSON.parse(r.out) as { id: string; status: string; detail: string }[]
  expect(checks.find((c) => c.id === "gateway")).toMatchObject({ status: "fail" })
  expect(r.out).not.toContain("wrong-key-0000")
}, 120_000)
