// Ezkielyna Wave B "exec" lane: /tasks (background commands). Spread into the ezk session commands.
import { createMemo, createResource, onCleanup } from "solid-js"
import type { ContextResponse, ExecOutputResponse, ExecTaskView, ExecTasksResponse, UsageResponse } from "@opencode-ai/core/ezk/exec/contracts"
import type { ContextBreakdown } from "@opencode-ai/core/ezk/diag/context"
import { type UsageReport, formatUSD, missCauseText, statusLine } from "@opencode-ai/core/ezk/diag/usage"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogAlert } from "../ui/dialog-alert"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import { type LaneKey, laneLang, laneT } from "./lane-strings"

type Transport = { fetch: typeof fetch; url: string; headers?: RequestInit["headers"] }

export function laneApi(t: Transport) {
  const call = async <T,>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const headers = new Headers(t.headers)
    if (body !== undefined) headers.set("content-type", "application/json")
    const res = await t.fetch(`${t.url.replace(/\/+$/, "")}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const json = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
    return json
  }
  return {
    tasks: (sessionID?: string) => call<ExecTasksResponse>("GET", `/ezk/exec${sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : ""}`),
    output: (id: string, sessionID: string) => call<ExecOutputResponse>("GET", `/ezk/exec/output?id=${encodeURIComponent(id)}&sessionID=${encodeURIComponent(sessionID)}`),
    stop: (id: string, sessionID: string) => call<{ ok: boolean }>("POST", "/ezk/exec/stop", { id, sessionID }),
    context: (sessionID: string) => call<ContextResponse>("GET", `/ezk/context?sessionID=${encodeURIComponent(sessionID)}`),
    usage: (sessionID: string) => call<UsageResponse>("GET", `/ezk/usage?sessionID=${encodeURIComponent(sessionID)}`),
  }
}

export function taskLine(task: ExecTaskView, t = laneT()) {
  const status = task.status === "running" ? t("tasks.running") : `${t(task.status === "killed" ? "tasks.killed" : "tasks.exited")} (${task.exitCode ?? "?"})`
  const seconds = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)
  return `${task.id} · ${status} · ${seconds}s · ${task.command}`
}

/** /tasks: background commands of this session, refreshed every 2 s. Enter shows output; running ones can be stopped. */
export function DialogTasks(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const t = laneT()
  const api = laneApi({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers })
  const [data, { refetch }] = createResource(() => api.tasks(props.sessionID))
  const timer = setInterval(() => void refetch(), 2_000)
  onCleanup(() => clearInterval(timer))
  dialog.setSize("large")

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const d = data()
    if (!d) return []
    if (!d.enabled) return [{ title: t("tasks.off"), value: "off" }]
    if (!d.tasks.length) return [{ title: t("tasks.none"), value: "none" }]
    return d.tasks.map((task) => ({
      title: taskLine(task, t),
      description: task.preview.split("\n").at(-1),
      value: task.id,
      category: task.status === "running" ? t("tasks.running") : t("tasks.exited"),
      onSelect: () =>
        openTask(
          dialog,
          task,
          api,
          t,
          () => toast.show({ message: t("tasks.stopped"), variant: "success" }),
          () => toast.show({ message: t("tasks.stop.failed"), variant: "error" }),
        ),
    }))
  })
  return <DialogSelect title={t("tasks.title")} options={options()} onSelect={(o) => o.onSelect?.(dialog)} />
}

async function openTask(
  dialog: DialogContext,
  task: ExecTaskView,
  api: ReturnType<typeof laneApi>,
  t: ReturnType<typeof laneT>,
  stopped: () => void,
  failed: () => void,
) {
  const output = await api.output(task.id, task.owner).catch(() => ({ output: task.preview }))
  const tail = output.output.trimEnd().split("\n").slice(-20).join("\n")
  if (task.status !== "running") return DialogAlert.show(dialog, `${t("tasks.output")} · ${task.id}`, tail || "(no output)")
  const ok = await DialogConfirm.show(dialog, `${task.id} · ${task.command}`, `${tail}\n\n${t("tasks.stop.ask")}`, t("tasks.stop"))
  if (ok) {
    try {
      await api.stop(task.id, task.owner)
      stopped()
    } catch {
      failed()
    }
  }
  dialog.clear()
}

const tokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** /context text: one row per part with tokens, % of the model's window and a bar. */
export function contextText(b: ContextBreakdown, t = laneT()) {
  const label = (part: string) => t(`context.part.${part}` as LaneKey)
  const width = Math.max(...b.rows.map((r) => label(r.part).length))
  const rows = b.rows.map((r) => `${label(r.part).padEnd(width)}  ${tokens(r.tokens).padStart(6)}  ${`${r.pct}%`.padStart(6)}  ${"█".repeat(Math.round(r.pct / 4))}`)
  return [
    `${b.modelID} · ${tokens(b.window)} tokens`,
    "",
    ...rows,
    "",
    `${t("context.used")}: ${tokens(b.used)} (${b.usedPct}%) · ${t(b.source === "measured" ? "context.measured" : "context.estimated")}`,
  ].join("\n")
}

/** /usage text: tokens, cost, cache line with the likely miss cause. */
export function usageText(r: UsageReport, t = laneT(), lang = laneLang()) {
  if (!r.steps) return t("usage.none")
  return [
    `${t("usage.steps")}: ${r.steps}`,
    `${t("usage.tokens")}: ${t("usage.in")} ${tokens(r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite)} · ${t("usage.out")} ${tokens(r.tokens.output)}`,
    `${t("usage.cost")}: ${formatUSD(r.costUSD)}`,
    `${t("usage.cache")}: ${r.cacheHitPct}% (${tokens(r.tokens.cacheRead)} ${t("usage.cached")}) · ${t("usage.last")} ${r.lastHitPct}%`,
    ...(r.missCause ? [`${t("usage.why")}: ${missCauseText(r.missCause, lang)}`] : []),
  ].join("\n")
}

/** Optional footer line (EZK_FEATURES=+statusline): context %, cost and cache hit, refreshed while the session changes. */
export function EzkStatusLine(props: { sessionID?: string; tick?: unknown }) {
  // Off by default: no request at all unless the flag is on in this process.
  if (!execEnabled("statusline")) return null
  const sdk = useSDK()
  const { theme } = useTheme()
  const api = laneApi({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers })
  const [data] = createResource(
    () => (props.sessionID ? { id: props.sessionID, tick: props.tick } : undefined),
    (key) => api.usage(key.id).catch(() => undefined),
  )
  const line = createMemo(() => {
    const d = data()
    if (!d?.enabled || !d.statusline) return ""
    return statusLine({ contextPct: d.contextPct, costUSD: d.report.costUSD, cacheHitPct: d.report.cacheHitPct, steps: d.report.steps })
  })
  return <>{line() ? <text fg={theme.textMuted}>{line()}</text> : null}</>
}

/** Slash commands of the exec lane, spread into ezkSessionCommands. */
export function laneCommands(deps: { dialog: DialogContext; sessionID: string; api: ReturnType<typeof laneApi> }) {
  const t = laneT()
  return [
    {
      title: t("context.title"),
      value: "ezk.context",
      category: "Session",
      slash: { name: "context" },
      run: async () => {
        const r = await deps.api.context(deps.sessionID).catch(() => undefined)
        const text = !r ? t("context.unknown") : !r.enabled ? t("context.off") : r.breakdown ? contextText(r.breakdown, t) : t("context.unknown")
        await DialogAlert.show(deps.dialog, t("context.title"), text)
      },
    },
    {
      title: t("usage.title"),
      value: "ezk.usage",
      category: "Session",
      slash: { name: "usage" },
      run: async () => {
        const r = await deps.api.usage(deps.sessionID).catch(() => undefined)
        const text = !r ? t("usage.none") : !r.enabled ? t("context.off") : usageText(r.report, t)
        await DialogAlert.show(deps.dialog, t("usage.title"), text)
      },
    },
    {
      title: t("tasks.title"),
      value: "ezk.tasks",
      category: "Session",
      slash: { name: "tasks" },
      run: () => deps.dialog.replace(() => <DialogTasks sessionID={deps.sessionID} />),
    },
  ]
}
