// U5 desktop: pure formatters and reducers behind the sidebar cost line, the status chips and the tasks panel.
import type { ExecTaskView, UsageResponse } from "@opencode-ai/core/ezk/exec/contracts"
import type { StatusResponse } from "@opencode-ai/core/ezk/exec/status-contract"

type Text = { en: string; id: string }

/** "$0.00" for nothing, four decimals below one cent so a cheap turn does not read as free. */
export function formatUSD(value: number | undefined) {
  const v = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
  if (v === 0) return "$0.00"
  if (v < 0.0001) return "<$0.0001"
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

export function formatTokens(n: number | undefined) {
  const v = Math.max(0, Math.round(n ?? 0))
  if (v < 1000) return String(v)
  if (v < 10_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/** 0..100 with no decimals; "<1%" for a real but tiny value. */
export function formatPct(pct: number | undefined) {
  if (pct === undefined || !Number.isFinite(pct) || pct <= 0) return "0%"
  if (pct < 1) return "<1%"
  return `${Math.min(100, Math.round(pct))}%`
}

export function formatRuntime(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

export function contextPct(promptTokens: number | undefined, window: number | undefined) {
  if (!promptTokens || !window || window <= 0) return undefined
  return Math.min(100, (promptTokens / window) * 100)
}

export type UsageView = {
  cost: string
  groupRatio?: number
  tokensIn: string
  tokensOut: string
  /** undefined when the model reports no cached tokens at all */
  cachePct?: string
  context?: { pct: number; label: string; window: string; high: boolean }
  empty: boolean
}

/** Reducer: raw /ezk/usage + /ezk/status -> what the sidebar draws. Prefers the server's context % (measured window), else computes it from agentContext. */
export function usageView(usage: UsageResponse | undefined, status: StatusResponse | undefined): UsageView | undefined {
  if (!usage || !usage.enabled) return undefined
  const r = usage.report
  const promptTotal = r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite
  const window = status?.agentContext
  const pct = usage.contextPct ?? contextPct(r.lastPromptTokens, window)
  const windowTokens = window ?? (usage.contextPct && r.lastPromptTokens ? Math.round((r.lastPromptTokens / usage.contextPct) * 100) : undefined)
  return {
    cost: formatUSD(r.costUSD),
    groupRatio: status?.price && status.price.groupRatio !== 1 ? status.price.groupRatio : undefined,
    tokensIn: formatTokens(promptTotal),
    tokensOut: formatTokens(r.tokens.output),
    cachePct: r.tokens.cacheRead > 0 ? formatPct(r.cacheHitPct) : undefined,
    context: pct === undefined ? undefined : { pct, label: formatPct(pct), window: formatTokens(windowTokens), high: pct >= 80 },
    empty: r.steps === 0,
  }
}

export type Chip = { id: "mode" | "trust" | "sandbox" | "web"; tone: "ok" | "warn" | "neutral"; text: Text; tip?: Text }

export type ChipInput = {
  permission?: { flags: { modes: boolean }; mode: { effective: string }; modes: { id: string; label: Text }[] }
  trust?: { trusted: boolean }
  status?: Pick<StatusResponse, "sandbox" | "webSearch">
}

const mapT = (en: string, id: string): Text => ({ en, id })

/** Reducer: server facts -> chips, in a fixed order. A chip is only produced when its fact is known (true state only). */
export function buildChips(input: ChipInput): Chip[] {
  const chips: Chip[] = []
  const p = input.permission
  if (p?.flags.modes && p.mode.effective === "full") {
    const m = p.modes.find((x) => x.id === p.mode.effective)
    if (m) chips.push({ id: "mode", tone: p.mode.effective === "full" ? "warn" : "neutral", text: m.label })
  }
  if (input.trust && !input.trust.trusted) {
    chips.push({
      id: "trust",
      tone: "warn",
      text: mapT("Folder not trusted", "Folder belum dipercaya"),
      tip: mapT(
        "The agent asks before editing files or running commands in this folder.",
        "Agent akan bertanya sebelum mengedit file atau menjalankan perintah di folder ini.",
      ),
    })
  }
  if (input.status) {
    const on = input.status.sandbox.active
    if (!on) {
      chips.push({
        id: "sandbox",
        tone: "warn",
        text: mapT("Sandbox off", "Sandbox mati"),
        tip: mapT(
          "Commands run directly on your computer, without isolation.",
          "Perintah berjalan langsung di komputer Anda, tanpa isolasi.",
        ),
      })
    }
  }
  return chips
}

/** Highest-severity status is the pill label; remaining statuses stay available in its tooltip. */
export function primaryChip(chips: Chip[]) {
  return chips.toSorted((a, b) => {
    const severity = { warn: 0, neutral: 1, ok: 2 }
    return severity[a.tone] - severity[b.tone]
  })[0]
}

export const sayText = (t: Text, lang: string | undefined) => (lang?.toLowerCase().startsWith("id") ? t.id : t.en)

export type TaskRow = { id: string; command: string; running: boolean; status: ExecTaskView["status"]; exitCode?: number; runtimeMs: number; lastLines: string[] }

/** Reducer: server task list -> rows. Running first (newest first), then finished. `now` is injected for tests. */
export function taskRows(tasks: ExecTaskView[], now: number, lines = 3): TaskRow[] {
  return tasks
    .map((t) => ({
      id: t.id,
      command: t.command,
      running: t.status === "running",
      status: t.status,
      exitCode: t.exitCode,
      runtimeMs: Math.max(0, (t.endedAt ?? now) - t.startedAt),
      lastLines: t.preview.trimEnd() ? t.preview.trimEnd().split("\n").slice(-lines) : [],
      startedAt: t.startedAt,
    }))
    .toSorted((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt)
    .map(({ startedAt: _s, ...row }) => row)
}

export const runningCount = (rows: TaskRow[]) => rows.filter((r) => r.running).length

/** The session id in a /:dir/session/:id path, or undefined on the home screen. */
export function sessionIDFromPath(path: string): string | undefined {
  return /\/session\/([^/?#]+)/.exec(path)?.[1]
}
