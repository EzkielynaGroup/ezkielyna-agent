// Result records (one JSON line per task in results.jsonl) and the markdown summary, optionally compared with a
// baseline run (`--baseline <results.jsonl>`).
import type { Tokens } from "./events"

export type Result = {
  id: string
  category: string
  lang: string
  pass: boolean
  reason: string
  skipped?: boolean
  turns: number
  duration_ms: number
  verify_ms: number
  tool_calls: number
  tool_errors: number
  edit_failures: number
  tool_error_details: { tool: string; error: string }[]
  agent_errors: string[]
  exit_code: number | null
  timed_out: boolean
  retry_attempts?: number
  tokens: Tokens
  /** Cost reported in the agent's own events (0 for models without client-side prices). */
  cost: number
  /** Cost estimated from tokens (--price, or the router's price table for the model that ran). */
  cost_estimated?: number
  price_source?: string
  cache_hit_ratio: number | null
  missing_keywords: string[]
  router?: {
    decisions: number
    fallbacks: number
    escalations: number
    models: Record<string, number>
    tiers: Record<string, number>
  }
  model: string
  /** Requested model or router alias; `model` records the last concrete router model when available. */
  requested_model?: string
  /** "ezkielyna" (this fork) or "upstream" (upstream OpenCode); absent in rows written before the upstream arm existed. */
  agent?: string
  /** What `<bin> --version` printed. */
  agent_version?: string
  /** "exec" (exec --json) or "run" (run --format json). */
  agent_mode: string
  features: string
  dry_run: boolean
}

export type Meta = {
  agent?: string
  model: string
  version: string
  bin: string
  mode: string
  features: string
  dryRun: boolean
  budget: number
  price?: string
  started: string
}

/** The cost a run is charged with: the larger of the reported and the estimated cost. */
export const costOf = (result: Pick<Result, "cost" | "cost_estimated">) =>
  Math.max(result.cost, result.cost_estimated ?? 0)

export function renderSummary(results: Result[], meta: Meta, baseline?: Result[]) {
  const ran = results.filter((result) => !result.skipped)
  const passed = results.filter((result) => result.pass).length
  const total = totals(ran)
  const byCategory = Object.entries(Object.groupBy(results, (result) => result.category))
  return [
    `# Bench v2: ${meta.model}${meta.dryRun ? " (DRY RUN, mock gateway)" : ""}`,
    "",
    `- Started: ${meta.started} UTC`,
    `- Agent: ${meta.agent ?? "ezkielyna"} · \`${meta.bin}\` ${meta.mode} (${meta.version || "version unknown"})`,
    `- EZK_FEATURES: ${meta.agent === "upstream" ? "none (upstream arm)" : `\`${meta.features || "(defaults)"}\``}`,
    `- Cost: ${meta.price ? `estimated with --price ${meta.price} (USD per 1M input/cached/output)` : "reported by the agent, or estimated from the router's price table"}`,
    `- Budget: ${Number.isFinite(meta.budget) ? `$${meta.budget}` : "none"}${results.length - ran.length ? `, ${results.length - ran.length} task(s) skipped` : ""}`,
    "",
    `**${passed}/${results.length} passed (${pct(passed, results.length)})** · ${total.turns} turns · ${seconds(total.ms)} agent time · ${total.toolErrors} tool error(s) in ${total.toolCalls} call(s) · ${total.editFailures} edit failure(s) · $${total.cost.toFixed(5)} · cache hit ${pct(total.cacheRead, total.input + total.cacheRead)}`,
    "",
    `Tokens: ${total.input} input, ${total.cacheRead} cached input, ${total.output} output, ${total.reasoning} reasoning. Router: ${total.decisions} decision(s), ${total.fallbacks} fallback(s), ${total.escalations} escalation(s)${
      Object.keys(total.models).length
        ? ` (${Object.entries(total.models)
            .map(([model, n]) => `${model} ×${n}`)
            .join(", ")})`
        : ""
    }.`,
    "",
    ...(baseline ? compare(results, baseline) : []),
    "## By category",
    "",
    "| Category | Passed | Avg turns | Avg time | Tool errors | Edit failures | Cost |",
    "|---|---|---|---|---|---|---|",
    ...byCategory.map(([category, items = []]) => {
      const sub = totals(items.filter((item) => !item.skipped))
      return `| ${category} | ${items.filter((item) => item.pass).length}/${items.length} | ${avg(sub.turns, sub.count)} | ${seconds(sub.ms / Math.max(1, sub.count))} | ${sub.toolErrors} | ${sub.editFailures} | $${sub.cost.toFixed(5)} |`
    }),
    "",
    "## Tasks",
    "",
    "| Task | Lang | Result | Turns | Time | Tool err | Edit fail | In / cached / out tokens | Cache hit | Cost |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...results.map(
      (result) =>
        `| ${result.id} | ${result.lang} | ${result.skipped ? "⏭ skipped" : result.pass ? "✅" : "❌"} | ${result.turns} | ${seconds(result.duration_ms)} | ${result.tool_errors} | ${result.edit_failures} | ${result.tokens.input} / ${result.tokens.cache_read} / ${result.tokens.output} | ${result.cache_hit_ratio === null ? "-" : pct(result.cache_hit_ratio, 1)} | $${costOf(result).toFixed(5)} |`,
    ),
    "",
    ...failures(results),
  ].join("\n")
}

/** Baseline comparison: headline deltas plus the tasks that flipped. */
// Only tasks present in both runs are compared, so a partial run (--tasks) can be checked against a full baseline.
export function compare(currentAll: Result[], baselineAll: Result[]) {
  const ids = new Set(baselineAll.map((result) => result.id))
  const current = currentAll.filter((result) => ids.has(result.id))
  const shared = new Set(current.map((result) => result.id))
  const baseline = baselineAll.filter((result) => shared.has(result.id))
  const now = totals(current.filter((result) => !result.skipped))
  const before = totals(baseline.filter((result) => !result.skipped))
  const passNow = current.filter((result) => result.pass).length
  const passBefore = baseline.filter((result) => result.pass).length
  const old = new Map(baseline.map((result) => [result.id, result]))
  const fixed = current
    .filter((result) => result.pass && old.get(result.id) && !old.get(result.id)!.pass)
    .map((result) => result.id)
  const broke = current
    .filter((result) => !result.pass && !result.skipped && old.get(result.id)?.pass)
    .map((result) => result.id)
  const missing = currentAll.filter((result) => !ids.has(result.id)).map((result) => result.id)
  const row = (name: string, a: string, b: string, delta: string) => `| ${name} | ${a} | ${b} | ${delta} |`
  const signed = (value: number, digits = 1) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`
  return [
    `## Compared with the baseline (${baselineAll[0]?.agent ?? "ezkielyna"} ${baselineAll[0]?.model ?? "?"}${baselineAll[0]?.features ? `, EZK_FEATURES ${baselineAll[0].features}` : ""})`,
    "",
    `On the ${current.length} task(s) present in both runs.`,
    "",
    "| Metric | Baseline | This run | Δ |",
    "|---|---|---|---|",
    row("Passed", `${passBefore}/${baseline.length}`, `${passNow}/${current.length}`, signed(passNow - passBefore, 0)),
    row(
      "Avg turns",
      avg(before.turns, before.count),
      avg(now.turns, now.count),
      signed(now.turns / Math.max(1, now.count) - before.turns / Math.max(1, before.count)),
    ),
    row(
      "Avg time",
      seconds(before.ms / Math.max(1, before.count)),
      seconds(now.ms / Math.max(1, now.count)),
      `${signed((now.ms / Math.max(1, now.count) - before.ms / Math.max(1, before.count)) / 1000)}s`,
    ),
    row("Tool errors", `${before.toolErrors}`, `${now.toolErrors}`, signed(now.toolErrors - before.toolErrors, 0)),
    row(
      "Edit failures",
      `${before.editFailures}`,
      `${now.editFailures}`,
      signed(now.editFailures - before.editFailures, 0),
    ),
    row("Cost", `$${before.cost.toFixed(5)}`, `$${now.cost.toFixed(5)}`, `${signed(now.cost - before.cost, 5)}`),
    row(
      "Cache hit",
      pct(before.cacheRead, before.input + before.cacheRead),
      pct(now.cacheRead, now.input + now.cacheRead),
      "",
    ),
    "",
    `Newly passing: ${fixed.length ? fixed.join(", ") : "none"}. Newly failing: ${broke.length ? broke.join(", ") : "none"}.${missing.length ? ` Not in the baseline: ${missing.join(", ")}.` : ""}`,
    "",
  ]
}

function failures(results: Result[]) {
  const failed = results.filter((result) => !result.pass && !result.skipped)
  if (failed.length === 0) return []
  return [
    "## Failures",
    "",
    ...failed.flatMap((result) => [
      `- **${result.id}**: ${result.reason.replaceAll("|", "\\|")}`,
      ...result.tool_error_details
        .slice(0, 3)
        .map((item) => `  - tool \`${item.tool}\`: ${item.error.replaceAll("\n", " ").slice(0, 200)}`),
    ]),
    "",
    "Per-task logs (events.jsonl, stderr, answer, diff.patch, verify output, router log) are in `logs/<task>/`.",
    "",
  ]
}

export function totals(results: Result[]) {
  return results.reduce(
    (sum, result) => ({
      count: sum.count + 1,
      turns: sum.turns + result.turns,
      ms: sum.ms + result.duration_ms,
      toolCalls: sum.toolCalls + result.tool_calls,
      toolErrors: sum.toolErrors + result.tool_errors,
      editFailures: sum.editFailures + (result.edit_failures ?? 0),
      cost: sum.cost + costOf(result),
      input: sum.input + result.tokens.input,
      output: sum.output + result.tokens.output,
      reasoning: sum.reasoning + result.tokens.reasoning,
      cacheRead: sum.cacheRead + result.tokens.cache_read,
      decisions: sum.decisions + (result.router?.decisions ?? 0),
      fallbacks: sum.fallbacks + (result.router?.fallbacks ?? 0),
      escalations: sum.escalations + (result.router?.escalations ?? 0),
      models: Object.entries(result.router?.models ?? {}).reduce(
        (models, [model, n]) => ({ ...models, [model]: (models[model] ?? 0) + n }),
        sum.models,
      ),
    }),
    {
      count: 0,
      turns: 0,
      ms: 0,
      toolCalls: 0,
      toolErrors: 0,
      editFailures: 0,
      cost: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      decisions: 0,
      fallbacks: 0,
      escalations: 0,
      models: {} as Record<string, number>,
    },
  )
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "-")
const avg = (sum: number, count: number) => (sum / Math.max(1, count)).toFixed(1)
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
