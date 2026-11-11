// End-to-end dry run of the upstream arm with a stub binary (test/fixtures/upstream-stub.ts) instead of upstream OpenCode:
// run.ts generates the upstream config, points it at the per-task mock gateway, runs the stub, grades a Q&A task.
import { beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseLines } from "../lib/events"
import type { Result } from "../lib/summary"

const BENCH = path.resolve(import.meta.dir, "..")
const STUB = path.join(import.meta.dir, "fixtures", "upstream-stub.ts")
const TASK = "qa-01-explain-shortener"
let out: string
let stdout = ""
let stderr = ""
let exitCode = -1

beforeAll(async () => {
  out = await mkdtemp(path.join(tmpdir(), "bench-upstream-test-"))
  const proc = Bun.spawn(
    [
      process.execPath,
      path.join(BENCH, "run.ts"),
      "--dry-run",
      "--agent", "upstream",
      "--bin", STUB,
      "--model", "deepseek-v4.1-flash",
      "--tasks", TASK,
      "--timeout", "90",
      "--out", out,
    ],
    {
      cwd: path.dirname(BENCH),
      // The stub's shebang is `#!/usr/bin/env bun`; make sure this bun is the one found.
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  ;[stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) console.error(`run.ts exited ${exitCode}\n${stderr}\n${stdout}`)
}, 120_000)

test("the dry run passes and announces the upstream arm", () => {
  expect(exitCode).toBe(0)
  expect(stdout).toContain("agent: upstream · ")
  expect(stdout).toContain("run --format json (1.19.3-stub)")
  expect(stdout).toContain("EZK_FEATURES: none (upstream arm)")
  expect(stdout).toContain(`PASS ${TASK}`)
})

test("the result row says agent: upstream with the binary version and no feature flags", async () => {
  const rows = parseLines(await Bun.file(path.join(out, "results.jsonl")).text()) as unknown as Result[]
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(row.agent).toBe("upstream")
  expect(row.agent_version).toBe("1.19.3-stub")
  expect(row.agent_mode).toBe("run")
  expect(row.features).toBe("")
  expect(row.pass).toBe(true)
  expect(row.agent_errors).toEqual([])
  expect(row.requested_model).toBe("ezk-bench/deepseek-v4.1-flash")
  expect(row.turns).toBe(2)
  expect(row.tool_calls).toBe(1)
  expect(row.tokens.cache_read).toBeGreaterThan(0)
  expect(row.price_source).toBe("pricing.ts:deepseek-v4.1-flash")
  expect(row.router?.decisions).toBe(0)
})

test("summary.md records the agent", async () => {
  const summary = await Bun.file(path.join(out, "summary.md")).text()
  expect(summary).toContain("- Agent: upstream · ")
  expect(summary).toContain("(1.19.3-stub)")
  expect(summary).toContain("- EZK_FEATURES: none (upstream arm)")
})

test("the generated opencode.json has the env template, never the key, and lives outside the workspace", async () => {
  const text = await Bun.file(path.join(out, "logs", TASK, "opencode.json")).text()
  expect(text).not.toContain("bench-dry-run-not-a-key")
  const config = JSON.parse(text)
  expect(config.provider["ezk-bench"].options.apiKey).toBe("{env:EZK_BENCH_UPSTREAM_KEY}")
  expect(config.provider["ezk-bench"].options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  expect(config.permission).toEqual({ "*": "allow" })
  expect(await Bun.file(path.join(out, "logs", TASK, "diff.patch")).text()).not.toContain("opencode.json")
})

test("the mock gateway served the requested model to the stub through the config", async () => {
  const events = parseLines(await Bun.file(path.join(out, "logs", TASK, "events.jsonl")).text())
  const stub = events.filter((event) => event.type === "bench_stub") as {
    requested: string
    served: string
    config: string
    keyEnv: string
  }[]
  expect(stub.length).toBe(2)
  expect(stub.every((event) => event.requested === "deepseek-v4.1-flash" && event.served === "deepseek-v4.1-flash")).toBe(true)
  expect(stub[0]!.keyEnv).toBe("EZK_BENCH_UPSTREAM_KEY")
  expect(stub[0]!.config).toMatch(/bench-home-.*opencode\.json$/)
  expect(events.filter((event) => event.type === "error")).toEqual([])
  expect(await Bun.file(path.join(out, "logs", TASK, "router.log.jsonl")).text()).toBe("")
})

test("after the run, nothing under the results dir holds the dry-run key", async () => {
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: out, dot: true }))
  for (const file of files) expect(await Bun.file(path.join(out, file)).text()).not.toContain("bench-dry-run-not-a-key")
  await rm(out, { recursive: true, force: true })
})
