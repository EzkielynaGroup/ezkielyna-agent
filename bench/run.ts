#!/usr/bin/env bun
// Bench v2 runner (DESIGN-V3 L8 Q1/Q2): runs the Ezkielyna agent on every task in bench/tasks and grades it.
//
//   bun bench/run.ts --dry-run                                        # mock gateway, no API key (CI)
//   EZK_BENCH_KEY=... bun bench/run.ts --gateway https://gateway.example --model ezk-auto --max-budget 1
//   bun bench/run.ts --dry-run --baseline bench/results/<earlier>/results.jsonl
//   bun bench/run.ts --dry-run --agent upstream --bin /path/to/opencode --model deepseek-v4.1-flash
//
// Per task: copy repo/ to a fresh temp workspace, run `ezkielyna exec --json` there (or `run --format json` when the
// agent has no exec command), copy the hidden tests in, then run the task's verify command and/or check its keywords.
// Records pass/fail, turns, wall time, tool errors, edit failures, tokens, cost, cache hits and router decisions.
// Writes results.jsonl, summary.md and per-task logs to --out.
//
// --agent upstream runs upstream OpenCode (`opencode run --format json`) against the same gateway and model through a
// generated opencode.json (lib/agent-args.ts: upstreamConfig), so a run can say "Ezkielyna vs upstream, same model".
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import {
  AGENTS,
  UPSTREAM_ENV,
  UPSTREAM_KEY_ENV,
  UPSTREAM_PROVIDER,
  agentArgs as buildAgentArgs,
  upstreamArgs,
  upstreamConfig,
  type Agent,
  type AgentMode,
} from "./lib/agent-args"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { BudgetGuard } from "./lib/budget"
import { estimateCost, estimateCostForModels, parsePrice } from "./lib/cost"
import { safeEnvironment } from "./lib/environment"
import { measure, parseLines, summarizeRouter } from "./lib/events"
import { retryableInfrastructureFailure } from "./lib/retry"
import { costOf, renderSummary, type Result } from "./lib/summary"
import {
  copyHiddenTests,
  loadTasks,
  prepareWorkspace,
  referenceAnswer,
  removeWorkspace,
  sh,
  verify,
  type Task,
} from "./lib/tasks"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const DRY_RUN_KEY = "bench-dry-run-not-a-key"

const args = parseArgs({
  options: {
    model: { type: "string" },
    tasks: { type: "string" },
    features: { type: "string" },
    "max-budget": { type: "string" },
    gateway: { type: "string" },
    "key-env": { type: "string" },
    agent: { type: "string", default: "ezkielyna" },
    price: { type: "string" },
    parallel: { type: "string", default: "1" },
    "dry-run": { type: "boolean", default: false },
    baseline: { type: "string" },
    bin: { type: "string" },
    mode: { type: "string" },
    timeout: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
}).values

if (args.help) {
  console.log(`usage: bun bench/run.ts [options]
  --model <id>          "provider/model" or a bare Ezkielyna model id, e.g. ezk-auto (default: the agent's default;
                        ezk-auto in --dry-run, so the router is exercised)
  --tasks <filter>      comma-separated ids, id prefixes or category:<name> (default: all 30)
  --features=<list>     EZK_FEATURES for the agent, e.g. --features=-router,+mcp-defer (use "=": the value starts
                        with "-"; +router.log is always added)
  --max-budget <usd>    stop starting new tasks once the cost so far reaches this amount
  --gateway <https-url> gateway base URL for a real run (required; no credentials in the URL)
  --key-env <name>      environment variable that holds the key (default EZK_BENCH_KEY, or EZK_BENCH_UPSTREAM_KEY with
                        --agent upstream; never printed)
  --agent <name>        ezkielyna (default) or upstream: upstream OpenCode v1.19.3 via \`opencode run --format json\`,
                        an OpenAI-compatible provider in a generated opencode.json pointing at --gateway, the key as a
                        {env:EZK_BENCH_UPSTREAM_KEY} template; --model is required (a concrete gateway model, no router)
  --price <in/cached/out>  USD per 1M tokens for the cost estimate (default: the router's price table)
  --parallel <n>        tasks run at the same time (default 1)
  --dry-run             use the shared mock gateway and a fake key; no network, no real model
  --baseline <file>     results.jsonl of an earlier run to compare with in summary.md
  --bin <path|source>   agent binary (default: \`ezkielyna\` on PATH, else "source" = bun packages/opencode/src/index.ts;
                        with --agent upstream: \`opencode\` on PATH)
  --mode <exec|run>     force the agent command (default: exec --json when the agent has it, else run --format json;
                        upstream is always run --format json)
  --timeout <seconds>   override every task's time limit
  --out <dir>           results directory (default bench/results/<time>-<model>)
  --keep                keep the temporary workspaces`)
  process.exit(0)
}

const dryRun = args["dry-run"]
if (!AGENTS.includes(args.agent as Agent)) {
  console.error(`--agent must be one of ${AGENTS.join(", ")}`)
  process.exit(2)
}
const agent = args.agent as Agent
const upstream = agent === "upstream"
// Upstream has no router: it needs a concrete gateway model (the dry run uses the mock's plain "default-model").
if (upstream && !args.model && !dryRun) {
  console.error("--model <gateway model> is required with --agent upstream (upstream has no ezk-auto router)")
  process.exit(2)
}
if (upstream && args.features) {
  console.error("--features is an Ezkielyna option (EZK_FEATURES); upstream OpenCode ignores it, so it is refused")
  process.exit(2)
}
if (upstream && args.mode && args.mode !== "run") {
  console.error("--agent upstream always runs `opencode run --format json`; --mode exec is not available upstream")
  process.exit(2)
}
const model = upstream
  ? `${UPSTREAM_PROVIDER}/${(args.model ?? "default-model").replace(/^(ezkielyna|ezk-bench)\//, "")}`
  : qualify(args.model ?? (dryRun ? "ezk-auto" : undefined))
const budget = args["max-budget"] === undefined ? Infinity : Number(args["max-budget"])
if ((!Number.isFinite(budget) && budget !== Infinity) || budget < 0) {
  console.error("--max-budget must be a non-negative USD amount")
  process.exit(2)
}
if (!dryRun && args["max-budget"] === undefined) {
  console.error("--max-budget is required for a real run")
  process.exit(2)
}
const parallel = Number(args.parallel)
if (!Number.isInteger(parallel) || parallel < 1) {
  console.error("--parallel must be a positive integer")
  process.exit(2)
}
if (Number.isFinite(budget) && parallel !== 1) {
  console.error("a finite --max-budget requires --parallel 1 so the run-wide budget can stop before starting another task")
  process.exit(2)
}
const rates = parsePrice(args.price)
// The upstream arm gets no EZK_* variables at all (and no +router.log: there is no router to log).
const features = upstream ? "" : [args.features, "+router.log"].filter(Boolean).join(",")
const keyEnv = args["key-env"] ?? (upstream ? UPSTREAM_KEY_ENV : "EZK_BENCH_KEY")
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
  console.error("--key-env must be a valid environment variable name")
  process.exit(2)
}
const apiKey = dryRun ? DRY_RUN_KEY : process.env[keyEnv]
if (!dryRun && !apiKey) {
  console.error(`Environment variable ${keyEnv} is not set. Set it for a real run, or use --dry-run.`)
  process.exit(2)
}
const gateway = args.gateway
if (!dryRun && !gateway) {
  console.error("--gateway https://<gateway> is required for a real run")
  process.exit(2)
}
if (gateway && !validGateway(gateway)) {
  console.error("--gateway must be an HTTPS URL without username or password")
  process.exit(2)
}
const bin = resolveBin(args.bin)
// Keep credentials in the benchmark process only. The one selected key is injected explicitly into the CLI below.
const childBaseEnv = safeEnvironment()
delete childBaseEnv[keyEnv]
const probeEnv = upstream
  ? { ...childBaseEnv, ...UPSTREAM_ENV }
  : { ...childBaseEnv, ...(dryRun ? { EZKIELYNA_API_KEY: DRY_RUN_KEY } : {}) }
const version = (await run([...bin, "--version"], { cwd: tmpdir(), env: probeEnv, timeoutMs: 120_000 })).stdout.trim()
const mode = upstream ? "run" : (args.mode ?? (await detectMode()))
const baseline = args.baseline ? (parseLines(await Bun.file(args.baseline).text()) as unknown as Result[]) : undefined
const tasks = await loadTasks(args.tasks)
if (tasks.length === 0) {
  console.error(`no tasks match ${args.tasks}`)
  process.exit(2)
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const out = path.resolve(
  args.out ?? path.join(import.meta.dir, "results", `${stamp}-${(model ?? "default").replace(/[^\w.-]+/g, "_")}`),
)
await mkdir(path.join(out, "logs"), { recursive: true })

console.log(
  `bench: ${tasks.length} task(s), model ${model ?? "(agent default)"}, ${dryRun ? "DRY RUN (mock gateway)" : "real gateway"}, parallel ${parallel}`,
)
console.log(
  `agent: ${agent} · ${bin.join(" ")} ${mode === "exec" ? "exec --json" : "run --format json"} (${version || "version unknown"})`,
)
console.log(`${upstream ? "EZK_FEATURES: none (upstream arm)" : `EZK_FEATURES=${features}`}\nout:   ${out}\n`)

const results: Result[] = []
const budgetGuard = new BudgetGuard(budget)
const queue = [...tasks]
await Promise.all(
  Array.from({ length: Math.min(parallel, tasks.length) }, async () => {
    while (queue.length > 0) {
      const task = queue.shift()!
      if (!budgetGuard.canStart()) {
        results.push(skipped(task))
        console.log(`skip ${task.id}: budget of $${budget} reached`)
        continue
      }
      const result = await runTask(task)
      budgetGuard.record(costOf(result))
      results.push(result)
      await appendFile(path.join(out, "results.jsonl"), JSON.stringify(result) + "\n")
      console.log(
        `${result.pass ? "PASS" : "FAIL"} ${task.id} · ${result.turns} turn(s) · ${(result.duration_ms / 1000).toFixed(1)}s · ${result.tool_errors} tool error(s) · $${costOf(result).toFixed(5)}${result.reason ? ` · ${result.reason}` : ""}`,
      )
    }
  }),
)

results.sort((a, b) => a.id.localeCompare(b.id))
await Bun.write(path.join(out, "results.jsonl"), results.map((result) => JSON.stringify(result)).join("\n") + "\n")
const summary = renderSummary(
  results,
  {
    agent,
    model: model ?? "(agent default)",
    version,
    bin: bin.join(" "),
    mode,
    features,
    dryRun,
    budget,
    price: args.price,
    started: stamp,
  },
  baseline,
)
await Bun.write(path.join(out, "summary.md"), summary)
console.log(`\n${summary.split("\n").slice(0, 12).join("\n")}\n…\nfull summary: ${path.join(out, "summary.md")}`)

// A dry run checks the harness itself: every reference solution must pass through the agent, so a failure is a bug.
if (dryRun && results.some((result) => !result.pass && !result.skipped)) process.exit(1)

async function runTask(task: Task): Promise<Result> {
  const logs = path.join(out, "logs", task.id)
  await mkdir(logs, { recursive: true })
  const ws = await prepareWorkspace(task)
  const home = await mkdtemp(path.join(tmpdir(), `bench-home-${task.id}-`))
  const timeoutMs = (Number(args.timeout) || task.timeout_sec || 600) * 1000

  const started = performance.now()
  const attempts: Awaited<ReturnType<typeof run>>[] = []
  while (attempts.length < 2) {
    const mock = dryRun ? await dryRunGateway(task, ws) : undefined
    // Upstream reads its config from HOME (OPENCODE_CONFIG), not from the workspace: project config stays disabled
    // like in the Ezkielyna arm and the file never shows up in diff.patch. A copy goes to logs/<task>/ for the record.
    if (upstream) {
      const config = JSON.stringify(upstreamConfig(mock?.url ?? gateway!, model!.slice(UPSTREAM_PROVIDER.length + 1)), null, 2)
      await Promise.all([Bun.write(path.join(home, "opencode.json"), config), Bun.write(path.join(logs, "opencode.json"), config)])
    }
    let child: Awaited<ReturnType<typeof run>>
    try {
      child = await run([...bin, ...agentArgs(ws, task.prompt)], {
        cwd: ws,
        env: agentEnv(ws, home, mock?.url),
        timeoutMs,
      })
    } finally {
      mock?.stop()
    }
    attempts.push({ ...child, stdout: redact(child.stdout), stderr: redact(child.stderr) })
    if (attempts.length === 1 && retryableInfrastructureFailure({
      exitCode: attempts[0]!.code,
      timedOut: attempts[0]!.timedOut,
      stdout: attempts[0]!.stdout,
      stderr: attempts[0]!.stderr,
    })) {
      console.log(`retry ${task.id}: infrastructure failure`)
      await Bun.sleep(200)
      continue
    }
    break
  }
  const child = attempts.at(-1)!
  const stdout = attempts.map((attempt) => attempt.stdout).join("\n")
  const stderr = attempts.map((attempt) => attempt.stderr).join("\n")
  const durationMs = Math.round(performance.now() - started)

  const metrics = measure(parseLines(stdout))
  const routerLog = upstream ? "" : await readRouterLog(home)
  const router = summarizeRouter(routerLog)
  const pricedModel = model === "ezkielyna/ezk-auto" || !model ? router.lastModel : model
  const estimate = model === "ezkielyna/ezk-auto" || !model
    ? estimateCostForModels(metrics.tokens, Object.keys(router.models), rates)
    : estimateCost(metrics.tokens, bareModel(pricedModel), rates)
  const diff = await sh(
    "git add -A >/dev/null 2>&1; git diff --cached --stat HEAD; echo; git diff --cached HEAD",
    ws,
    60_000,
  )
  await copyHiddenTests(task, ws)
  const verifyStarted = performance.now()
  const grade = await verify(task, ws, metrics.answer)
  const verifyMs = Math.round(performance.now() - verifyStarted)

  await Promise.all([
    Bun.write(path.join(logs, "events.jsonl"), stdout),
    Bun.write(path.join(logs, "stderr.txt"), stderr),
    Bun.write(path.join(logs, "answer.md"), metrics.answer),
    Bun.write(path.join(logs, "diff.patch"), redact(diff.output)),
    Bun.write(path.join(logs, "verify.txt"), redact(grade.verify_output ?? "")),
    Bun.write(path.join(logs, "router.log.jsonl"), redact(routerLog)),
  ])
  if (!args.keep) await Promise.all([removeWorkspace(ws), rm(home, { recursive: true, force: true }).catch(() => {})])

  const reason = [
    child.timedOut ? `timed out after ${timeoutMs / 1000}s` : undefined,
    !child.timedOut && child.code !== 0 ? `agent exited ${child.code}` : undefined,
    metrics.errors.length ? `agent error: ${metrics.errors[0]}` : undefined,
    grade.verify_exit !== undefined && grade.verify_exit !== 0 ? `verify exited ${grade.verify_exit}` : undefined,
    grade.missing_keywords.length ? `missing keywords: ${grade.missing_keywords.join("; ")}` : undefined,
  ].filter((item): item is string => Boolean(item))

  return {
    id: task.id,
    category: task.category,
    lang: task.lang,
    pass: grade.pass,
    reason: grade.pass ? "" : reason.join("; ") || "failed",
    turns: metrics.turns,
    duration_ms: durationMs,
    verify_ms: verifyMs,
    tool_calls: metrics.toolCalls,
    tool_errors: metrics.toolErrors.length,
    edit_failures: metrics.editFailures,
    tool_error_details: metrics.toolErrors.slice(0, 10),
    agent_errors: metrics.errors.slice(0, 5),
    exit_code: child.code,
    timed_out: child.timedOut,
    retry_attempts: attempts.length - 1,
    tokens: metrics.tokens,
    cost: metrics.cost,
    cost_estimated: estimate?.usd,
    price_source: estimate?.source,
    cache_hit_ratio: metrics.cacheHitRatio,
    missing_keywords: grade.missing_keywords,
    router: {
      decisions: router.decisions,
      fallbacks: router.fallbacks,
      escalations: router.escalations,
      models: router.models,
      tiers: router.tiers,
    },
    agent,
    agent_version: version,
    agent_mode: mode,
    features,
    dry_run: dryRun,
    requested_model: model ?? "",
    model: pricedModel ?? model ?? "",
  }
}

function agentArgs(ws: string, prompt: string) {
  if (upstream) return upstreamArgs(ws, prompt, bareModel(model)!)
  return buildAgentArgs(mode as AgentMode, ws, prompt, model)
}

/** The model id without the provider prefix the arm adds (ezkielyna/… or ezk-bench/…): what the gateway and the price table know. */
function bareModel(value?: string) {
  return value?.replace(upstream ? /^ezk-bench\// : /^ezkielyna\//, "")
}

// The reference solution is copied into the (git-excluded) workspace so the mock's shell call can run it.
async function dryRunGateway(task: Task, ws: string) {
  const { startDryRunGateway } = await import("./lib/mock-gateway")
  const solution = Bun.file(path.join(task.dir, "solution.sh"))
  await Bun.write(
    path.join(ws, ".bench", "solution.sh"),
    (await solution.exists()) ? await solution.text() : "ls -la\n",
  )
  await appendFile(path.join(ws, ".git", "info", "exclude"), ".bench/\n")
  const answer = (await referenceAnswer(task)).trim() || "Selesai. Done."
  return startDryRunGateway({ script: "bash .bench/solution.sh", answer, model: bareModel(model) })
}

function agentEnv(ws: string, home: string, mockUrl?: string) {
  const base: Record<string, string | undefined> = {
    ...childBaseEnv,
    // The CLI resolves its project from PWD before the process cwd; without this, tools run in the caller's directory.
    PWD: ws,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  }
  // Upstream: no EZK_* variables; the gateway URL lives in the generated config, the key only in this one variable.
  if (upstream)
    return {
      ...base,
      ...UPSTREAM_ENV,
      OPENCODE_CONFIG: path.join(home, "opencode.json"),
      [UPSTREAM_KEY_ENV]: mockUrl ? DRY_RUN_KEY : apiKey,
    }
  const env: Record<string, string | undefined> = {
    ...base,
    EZK_FEATURES: features,
    EZK_TRUST_PROJECT: "1",
    EZK_NO_KEYCHAIN: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    NO_COLOR: "1",
  }
  if (mockUrl) return { ...env, EZKIELYNA_BASE_URL: mockUrl, EZKIELYNA_API_KEY: DRY_RUN_KEY }
  return { ...env, EZKIELYNA_BASE_URL: gateway, EZKIELYNA_API_KEY: apiKey }
}

async function readRouterLog(home: string) {
  const files = await Array.fromAsync(new Bun.Glob("**/ezk/router.log.jsonl").scan({ cwd: home, dot: true }))
  const texts = await Promise.all(files.map((file) => Bun.file(path.join(home, file)).text()))
  return texts.join("")
}

// `exec --help` exits 0 even when there is no exec command (yargs prints the general help), so require the exec
// usage line and its --json option.
async function detectMode() {
  const help = await run([...bin, "exec", "--help"], { cwd: tmpdir(), env: probeEnv, timeoutMs: 120_000 })
  const text = help.stdout + help.stderr
  return help.code === 0 && /\bexec\b/.test(text) && /--json\b/.test(text) ? "exec" : "run"
}

function qualify(value?: string) {
  if (!value) return undefined
  return value.includes("/") ? value : `ezkielyna/${value}`
}

function validGateway(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

function redact(value: string) {
  return apiKey ? value.split(apiKey).join("[REDACTED]") : value
}

function resolveBin(value?: string) {
  if (value && value !== "source") return [path.resolve(value)]
  if (upstream) {
    const found = Bun.which("opencode")
    if (!found || value === "source") {
      console.error("--agent upstream needs upstream OpenCode: `opencode` on PATH or --bin <path> (this repo is not it)")
      process.exit(2)
    }
    return [found]
  }
  const source = [process.execPath, path.join(REPO_ROOT, "packages", "opencode", "src", "index.ts")]
  if (value === "source") return source
  const found = Bun.which("ezkielyna")
  return found ? [found] : source
}

function skipped(task: Task): Result {
  return {
    id: task.id,
    category: task.category,
    lang: task.lang,
    pass: false,
    reason: "skipped: budget reached",
    skipped: true,
    turns: 0,
    duration_ms: 0,
    verify_ms: 0,
    tool_calls: 0,
    tool_errors: 0,
    edit_failures: 0,
    tool_error_details: [],
    agent_errors: [],
    exit_code: null,
    timed_out: false,
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
    cache_hit_ratio: null,
    missing_keywords: [],
    model: model ?? "",
    agent,
    agent_version: version,
    agent_mode: mode,
    features,
    dry_run: dryRun,
  }
}

async function run(cmd: string[], opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, opts.timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { stdout, stderr, code, timedOut }
}
