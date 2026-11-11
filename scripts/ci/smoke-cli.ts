#!/usr/bin/env bun
// Smoke test for a compiled `ezkielyna` CLI binary.
//
//   bun scripts/ci/smoke-cli.ts packages/opencode/dist/opencode-linux-x64/bin/ezkielyna
//
// Runs a handful of read-only commands plus one `run` prompt against a local mock
// OpenAI-compatible server, in an isolated HOME. No network, no API key. Fails when
// any command exits non-zero, times out, or prints a module resolution error
// (ERR_MODULE_NOT_FOUND and friends), which is how a broken bundle usually shows up.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BROKEN_BUNDLE, findBrokenBundle } from "./broken-bundle"
import { safeEnv } from "./safe-env"

const binary = process.argv[2] ? path.resolve(process.argv[2]) : undefined
if (!binary || !(await Bun.file(binary).exists())) {
  console.error(`usage: bun scripts/ci/smoke-cli.ts <path to ezkielyna binary> (got ${process.argv[2] ?? "nothing"})`)
  process.exit(2)
}

const REPLY = "ezkielyna-ci-smoke-ok"

// Minimal streaming /v1/chat/completions: one text delta, a stop chunk, [DONE].
const mock = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models"))
      return Response.json({ object: "list", data: [{ id: "smoke-model", object: "model" }] })
    if (url.pathname === "/api/pricing") return Response.json({ success: true, group_ratio: { default: 1 }, data: [] })
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const base = { id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 0, model: "smoke-model" }
    const body = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }] },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .concat("data: [DONE]\n\n")
      .join("")
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  },
})

const home = await mkdtemp(path.join(tmpdir(), "ezk-cli-smoke-"))
const ezkConfig = path.join(home, ".config", "ezkielyna")
await mkdir(ezkConfig, { recursive: true })
await writeFile(path.join(ezkConfig, "ezkielyna.json"), JSON.stringify({ ezk: { router: { policyURL: "" } } }))
const env = {
  ...safeEnv(process.env),
  OPENCODE_TEST_HOME: home,
  EZKIELYNA_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
  OPENCODE_CONFIG_DIR: ezkConfig,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local/share"),
  XDG_STATE_HOME: path.join(home, ".local/state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    formatter: false,
    lsp: false,
    provider: {
      smoke: {
        name: "Smoke",
        id: "smoke",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "smoke-model": {
            id: "smoke-model",
            name: "Smoke Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "mock-key", baseURL: `http://127.0.0.1:${mock.port}/v1` },
      },
    },
  }),
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_PURE: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_AUTOCOMPACT: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_AUTH_CONTENT: "{}",
  NO_COLOR: "1",
}

const checks: { args: string[]; expect?: string }[] = [
  { args: ["--version"] },
  { args: ["--help"] },
  { args: ["models"], expect: "smoke/smoke-model" },
  { args: ["providers", "list"] },
  { args: ["mcp", "list"] },
  { args: ["debug", "config"] },
  { args: ["run", "--model", "smoke/smoke-model", "say hi"], expect: REPLY },
]

const failures = []
for (const check of checks) {
  const label = `ezkielyna ${check.args.join(" ")}`
  const started = performance.now()
  const proc = Bun.spawn([binary, ...check.args], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 90_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  const output = stdout + stderr
  const broken = findBrokenBundle(output)
  const problem = [
    code !== 0
      ? `exit code ${code}${proc.signalCode ? ` (${proc.signalCode}, likely the 90s timeout)` : ""}`
      : undefined,
    broken ? `module resolution error: ${broken}` : undefined,
    check.expect && !output.includes(check.expect)
      ? `output does not contain ${JSON.stringify(check.expect)}`
      : undefined,
  ].filter(Boolean)
  const ms = Math.round(performance.now() - started)
  if (problem.length === 0) {
    console.log(`ok   ${label} (${ms} ms)`)
    continue
  }
  console.log(`FAIL ${label} (${ms} ms): ${problem.join("; ")}`)
  console.log(indent(output.slice(-4000)))
  failures.push(label)
}

mock.stop(true)
await rm(home, { recursive: true, force: true }).catch(() => {})

if (failures.length > 0) {
  console.error(`\n${failures.length} CLI smoke check(s) failed (patterns checked: ${BROKEN_BUNDLE.join(", ")})`)
  process.exit(1)
}
console.log(`\nCLI smoke passed: ${checks.length} checks`)

function indent(text: string) {
  return text
    .split("\n")
    .map((line) => `     | ${line}`)
    .join("\n")
}
