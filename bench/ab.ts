#!/usr/bin/env bun
// Interleaved paired A/B runs. Each child receives exactly one task so the two arms alternate per task/repeat.
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { armLabel, pairedSignTest, parseArm, type Arm } from "./lib/ab"
import { costOf, type Result } from "./lib/summary"
import { loadTasks } from "./lib/tasks"

const REPO_ROOT = path.resolve(import.meta.dir, "..")
const options = parseArgs({
  options: {
    a: { type: "string" },
    b: { type: "string" },
    tasks: { type: "string" },
    repeats: { type: "string", default: "2" },
    model: { type: "string" },
    gateway: { type: "string" },
    "key-env": { type: "string", default: "EZK_BENCH_KEY" },
    "max-budget": { type: "string" },
    price: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    bin: { type: "string" },
    "upstream-bin": { type: "string" },
    mode: { type: "string" },
    timeout: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean", default: false },
  },
}).values

if (options.help) {
  console.log(`usage: bun bench/ab.ts --a "EZK_FEATURES=..." --b "EZK_FEATURES=..." --tasks <filter> [options]
       bun bench/ab.ts --a 'agent=ezkielyna' --b 'agent=upstream' --model <gateway model> --tasks <filter> [options]
  --a, --b <arm>        whitespace-separated: agent=ezkielyna|upstream, model=<id>, EZK_FEATURES=<list> (or a bare list)
  --repeats <n>         interleaved repeats per task (default 2)
  --model <id>          model for both arms (an arm's model= overrides it); required by an upstream arm, which has no router
  --gateway <https-url> gateway base URL for a real run
  --key-env <name>      key environment variable (default EZK_BENCH_KEY; its value is never printed)
  --max-budget <usd>    total estimated spend cap across both arms (required for real runs)
  --bin <path>          Ezkielyna binary for ezkielyna arms; --upstream-bin <path> the opencode binary for upstream arms
  --dry-run             use the local mock gateway; never contacts the real gateway`)
  process.exit(0)
}

const a = arm(options.a, "A")
const b = arm(options.b, "B")
for (const selected of [a, b]) {
  if (selected.agent === "upstream" && !selected.model && !options.model && !options["dry-run"])
    fail(`arm ${selected.name} runs upstream OpenCode, which has no router: give --model or model=<id>`)
}
const repeats = Number(options.repeats)
if (!Number.isInteger(repeats) || repeats < 1) fail("--repeats must be a positive integer")
const maxBudget = options["max-budget"] === undefined ? Infinity : Number(options["max-budget"])
if ((!Number.isFinite(maxBudget) && maxBudget !== Infinity) || maxBudget < 0) fail("--max-budget must be non-negative")
if (!options["dry-run"] && options["max-budget"] === undefined) fail("--max-budget is required for real runs")

const tasks = await loadTasks(options.tasks)
if (tasks.length === 0) fail(`no tasks match ${options.tasks}`)
const out = path.resolve(options.out ?? path.join(import.meta.dir, "results", `ab-${new Date().toISOString().replace(/[:.]/g, "-")}`))
await mkdir(out, { recursive: true })
const runs = new Map<string, Result>()
let spent = 0
let stoppedForBudget = false

for (let repeat = 0; repeat < repeats && !stoppedForBudget; repeat++) {
  for (const [index, task] of tasks.entries()) {
    const order = (index + repeat) % 2 === 0 ? [a, b] : [b, a]
    for (const selected of order) {
      if (spent >= maxBudget) {
        stoppedForBudget = true
        break
      }
      const remaining = Number.isFinite(maxBudget) ? Math.max(0, maxBudget - spent) : undefined
      const result = await runOne(task.id, repeat, selected, remaining, out)
      if (result.skipped) {
        stoppedForBudget = true
        break
      }
      runs.set(key(task.id, repeat, selected.name), result)
      spent += costOf(result)
      console.log(`${selected.name} ${task.id} · ${result.pass ? "PASS" : "FAIL"} · $${costOf(result).toFixed(5)}`)
    }
    if (stoppedForBudget) break
  }
}

const pairs = tasks.flatMap((task) =>
  Array.from({ length: repeats }, (_, repeat) => {
    const aResult = runs.get(key(task.id, repeat, a.name))
    const bResult = runs.get(key(task.id, repeat, b.name))
    return aResult && bResult ? { id: task.id, repeat, a: aResult, b: bResult } : undefined
  }).filter((pair): pair is { id: string; repeat: number; a: Result; b: Result } => Boolean(pair)),
)
const sign = pairedSignTest(pairs.map((pair) => ({ aPass: pair.a.pass, bPass: pair.b.pass })))
const aValues = pairs.map((pair) => pair.a)
const bValues = pairs.map((pair) => pair.b)
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const avg = (results: Result[], pick: (result: Result) => number) => mean(results.map(pick))
const pct = (results: Result[]) => results.length ? `${Math.round(results.filter((result) => result.pass).length / results.length * 100)}%` : "-"
const delta = (pick: (result: Result) => number) => (avg(bValues, pick) - avg(aValues, pick)).toFixed(3)
const markdown = [
  `# Bench v2 A/B: ${a.name} vs ${b.name}`,
  "",
  `- Tasks requested: ${tasks.length}; repeats: ${repeats}; complete paired runs: ${pairs.length}.`,
  `- Estimated spend: $${spent.toFixed(5)}${stoppedForBudget ? ` (stopped at budget $${maxBudget})` : ""}.`,
  "",
  "| Arm | Paired runs | Pass rate | Avg turns | Avg cost | Avg time |",
  "|---|---:|---:|---:|---:|---:|",
  `| A · \`${armLabel(a)}\` | ${aValues.length} | ${pct(aValues)} | ${avg(aValues, (result) => result.turns).toFixed(2)} | $${avg(aValues, costOf).toFixed(5)} | ${(avg(aValues, (result) => result.duration_ms) / 1000).toFixed(2)}s |`,
  `| B · \`${armLabel(b)}\` | ${bValues.length} | ${pct(bValues)} | ${avg(bValues, (result) => result.turns).toFixed(2)} | $${avg(bValues, costOf).toFixed(5)} | ${(avg(bValues, (result) => result.duration_ms) / 1000).toFixed(2)}s |`,
  `| Δ B−A | ${pairs.length} | — | ${delta((result) => result.turns)} | $${delta(costOf)} | ${(avg(bValues, (result) => result.duration_ms) - avg(aValues, (result) => result.duration_ms)) / 1000 >= 0 ? "+" : ""}${((avg(bValues, (result) => result.duration_ms) - avg(aValues, (result) => result.duration_ms)) / 1000).toFixed(2)}s |`,
  "",
  `Paired sign test on pass/fail outcomes: A-only wins ${sign.aWins}, B-only wins ${sign.bWins}, ties ${sign.ties}, two-sided p=${sign.pValue.toFixed(4)}.${sign.tooSmall ? " Sample too small: fewer than 10 non-tied pairs." : ""}`,
  "",
  ...(!pairs.length ? ["No complete task pairs were produced; no paired comparison is available.", ""] : []),
  "Runs are interleaved per task and repeat; order alternates between A→B and B→A. The test is descriptive and does not replace a larger benchmark sample.",
  "",
].join("\n")
await Bun.write(path.join(out, "AB.md"), markdown)
console.log(`\n${markdown}\nfull report: ${path.join(out, "AB.md")}`)

async function runOne(taskID: string, repeat: number, selected: Arm, remaining: number | undefined, root: string) {
  const runOut = path.join(root, `repeat-${repeat + 1}`, taskID, selected.name)
  const command = [process.execPath, path.join(import.meta.dir, "run.ts")]
  // The key variable is shared by both arms: run.ts injects its value under the name each agent reads.
  const args = [`--tasks=${taskID}`, `--agent=${selected.agent}`, `--out=${runOut}`, `--key-env=${options["key-env"]}`]
  const upstream = selected.agent === "upstream"
  if (!upstream) args.push(`--features=${selected.features}`)
  const model = selected.model ?? options.model
  if (model) args.push(`--model=${model}`)
  if (options.gateway) args.push(`--gateway=${options.gateway}`)
  if (remaining !== undefined) args.push(`--max-budget=${remaining}`)
  if (options["dry-run"]) args.push("--dry-run")
  if (options.price) args.push(`--price=${options.price}`)
  if (!upstream && options.bin) args.push(`--bin=${options.bin}`)
  if (upstream && options["upstream-bin"]) args.push(`--bin=${options["upstream-bin"]}`)
  if (!upstream && options.mode) args.push(`--mode=${options.mode}`)
  if (options.timeout) args.push(`--timeout=${options.timeout}`)
  const proc = Bun.spawn([...command, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    const secret = process.env[options["key-env"] ?? "EZK_BENCH_KEY"]
    const details = `${stderr}\n${stdout}`.slice(-3000).split(secret || "\0").join("[REDACTED]")
    throw new Error(`${selected.name} ${taskID} run exited ${exitCode}:\n${details}`)
  }
  const records = (await Bun.file(path.join(runOut, "results.jsonl")).text()).trim().split("\n")
  return JSON.parse(records[0]!) as Result
}

function arm(value: string | undefined, name: Arm["name"]): Arm {
  if (value === undefined) fail(`--${name.toLowerCase()} is required`)
  try {
    return parseArm(value!, name)
  } catch (error) {
    return fail(String(error instanceof Error ? error.message : error))
  }
}

function key(taskID: string, repeat: number, name: string) {
  return `${taskID}:${repeat}:${name}`
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}
