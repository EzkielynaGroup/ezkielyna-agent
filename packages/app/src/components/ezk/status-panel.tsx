import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { type Chip, type TaskRow, type UsageView, buildChips, primaryChip, runningCount, sayText, taskRows, usageView, formatRuntime } from "./status-model"
import { statusT } from "./status-strings"
import { type EzkConnection } from "./client"
import { laneClient, laneT } from "./lane-client"
import { statusClient } from "./status-client"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { confirmAction } from "@/components/confirm-action"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { createFocusPoll } from "@/utils/focus-poll"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

const tone: Record<Chip["tone"], string> = {
  ok: "bg-v2-background-bg-layer-03 text-v2-text-text-base",
  warn: "bg-v2-background-bg-layer-03 text-v2-text-text-base outline outline-1 -outline-offset-1 outline-v2-border-border-focus",
  neutral: "bg-v2-background-bg-layer-03 text-v2-text-text-muted",
}

/** Status chips: mode, folder trust, sandbox (true state) and web search. Presentational. */
export function EzkChips(props: { chips: Chip[]; lang?: string }) {
  const primary = createMemo(() => primaryChip(props.chips))
  const tooltip = createMemo(() =>
    props.chips
      .map((chip) => [sayText(chip.text, props.lang), chip.tip && sayText(chip.tip, props.lang)].filter(Boolean).join("\n"))
      .join("\n\n"),
  )

  return (
    <Show when={primary()}>
      {(chip) => (
        <div class="ezk-status-pill-wrap max-[900px]:hidden" data-component="ezk-status-pill">
          <TooltipV2 placement="top" value={tooltip()}>
            <button type="button" class={`ezk-status-pill ${tone[chip().tone]}`} aria-label={tooltip()}>
              <IconV2 name="status" size="small" aria-hidden="true" />
              <span>{sayText(chip().text, props.lang)}</span>
            </button>
          </TooltipV2>
        </div>
      )}
    </Show>
  )
}

/** Cost, tokens, cache hit and context of the session. Presentational. */
export function EzkUsageBlock(props: { view?: UsageView; lang?: string }) {
  const t = createMemo(() => statusT(props.lang))
  const row = (k: string, v: string, tip?: string) => (
    <div class="flex items-baseline justify-between gap-2" title={tip}>
      <span class="text-v2-text-text-muted">{k}</span>
      <span class="text-v2-text-text-base">{v}</span>
    </div>
  )
  return (
    <div class="flex flex-col gap-1 px-2 text-[12px] max-[900px]:hidden" data-component="ezk-usage">
      <span class="text-[11px] font-[560] uppercase tracking-wide text-v2-text-text-faint">{t()("usage.title")}</span>
      <Show when={props.view && !props.view.empty} fallback={<span class="text-v2-text-text-muted">{t()("usage.empty")}</span>}>
        {row(
          t()("usage.cost"),
          props.view!.cost,
          t()("usage.costTip", { group: props.view!.groupRatio ? t()("usage.group", { ratio: props.view!.groupRatio }) : "" }),
        )}
        {row(t()("usage.tokens"), t()("usage.tokensValue", { input: props.view!.tokensIn, output: props.view!.tokensOut }))}
        {row(t()("usage.cache"), props.view!.cachePct ?? t()("usage.cacheNone"))}
        <Show when={props.view!.context}>
          {(c) => (
            <div class="flex flex-col gap-0.5">
              {row(t()("usage.context"), t()("usage.contextOf", { pct: c().label, window: c().window }))}
              <div class="h-1 overflow-hidden rounded-full bg-v2-background-bg-layer-03" role="progressbar" aria-valuenow={Math.round(c().pct)} aria-valuemin={0} aria-valuemax={100}>
                <div class={`h-full ${c().high ? "bg-v2-border-border-focus" : "bg-v2-background-bg-accent"}`} style={{ width: `${Math.min(100, c().pct)}%` }} />
              </div>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

/** One list of background tasks: command, status, runtime, last lines, Show output and Stop. Presentational. */
export function EzkTasksList(props: {
  rows: TaskRow[]
  lang?: string
  openId?: string
  output?: string
  onToggle: (row: TaskRow) => void
  onStop: (row: TaskRow) => void
}) {
  const lt = createMemo(() => laneT(props.lang))
  const st = createMemo(() => statusT(props.lang))
  const status = (r: TaskRow) =>
    r.running ? lt()("tasks.running") : `${lt()(r.status === "killed" ? "tasks.killed" : "tasks.exited")} (${r.exitCode ?? "?"})`
  const btn = "shrink-0 text-[12px] text-v2-text-text-muted hover:text-v2-text-text-base"
  return (
    <For each={props.rows} fallback={<span class="text-[13px] text-v2-text-text-muted">{lt()("tasks.none")}</span>}>
      {(r) => (
        <div class="flex flex-col gap-1 rounded-[8px] bg-v2-background-bg-layer-03 px-2 py-1.5" data-task={r.id}>
          <div class="flex items-center gap-2 text-[13px] text-v2-text-text-base">
            <span class="shrink-0 text-[11.5px] text-v2-text-text-muted">{status(r)}</span>
            <code class="min-w-0 flex-1 truncate">{r.command}</code>
            <button type="button" class={btn} onClick={() => props.onToggle(r)}>
              {props.openId === r.id ? lt()("tasks.hide") : lt()("tasks.output")}
            </button>
            <Show when={r.running}>
              <button type="button" class={btn} onClick={() => props.onStop(r)}>
                {lt()("tasks.stop")}
              </button>
            </Show>
          </div>
          <span class="text-[11.5px] text-v2-text-text-muted">{st()(r.running ? "tasks.runtime" : "tasks.ranFor", { time: formatRuntime(r.runtimeMs) })}</span>
          <Show when={props.openId !== r.id}>
            <pre class="max-h-16 overflow-hidden whitespace-pre-wrap text-[11.5px] text-v2-text-text-muted" aria-label={st()("tasks.lastLines")}>
              {r.lastLines.length ? r.lastLines.join("\n") : st()("tasks.noOutput")}
            </pre>
          </Show>
          <Show when={props.openId === r.id}>
            <pre class="max-h-64 overflow-auto whitespace-pre-wrap text-[11.5px] text-v2-text-text-muted">{props.output}</pre>
          </Show>
        </div>
      )}
    </For>
  )
}

/** Sidebar block: chips + cost line. Polls the server every 5 s while mounted. `directory` is the focused project folder. */
export function EzkStatusBlock(props: { conn: EzkConnection; directory?: string; sessionID?: string; lang?: string }) {
  const api = createMemo(() => statusClient(props.conn))
  const [usage, { refetch }] = createResource(
    () => props.sessionID,
    (id) => api().usage(id).catch(() => undefined),
  )
  const [facts, { refetch: refetchFacts }] = createResource(
    () => {
      const u = usage.latest
      return [props.directory, props.sessionID, u?.enabled ? u.report.lastModelID : undefined] as const
    },
    async ([dir, sid, model]) => {
      if (!dir) return undefined
      const [status, permission, trust] = await Promise.all([
        api().status(dir, sid, model).catch(() => undefined),
        api().permission(dir, sid).catch(() => undefined),
        api().trust(dir).catch(() => undefined),
      ])
      return { status, permission, trust }
    },
  )
  onCleanup(
    createFocusPoll(
      () => {
        void refetch()
        void refetchFacts()
      },
      5_000,
      60_000,
    ),
  )
  const chips = createMemo(() => buildChips(facts.latest ?? {}))
  return <EzkChips chips={chips()} lang={props.lang} />
}

/** Sidebar background-tasks panel. Renders nothing while the exec feature is off. */
export function EzkTasksPanel(props: { conn: EzkConnection; sessionID?: string; lang?: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const api = createMemo(() => laneClient(props.conn))
  const [data, { refetch }] = createResource(
    () => props.sessionID ?? "",
    (sid) => api().tasks(sid || undefined).catch(() => undefined),
  )
  onCleanup(createFocusPoll(() => void refetch(), 3_000, 60_000))
  const [open, setOpen] = createSignal<{ id: string; output: string }>()
  const rows = createMemo(() => taskRows(data.latest?.tasks ?? [], Date.now()))
  const t = createMemo(() => statusT(props.lang))
  const lt = createMemo(() => laneT(props.lang))
  return (
    <Show when={data.latest?.enabled && (rows().length > 0)}>
      <div class="flex flex-col gap-1 px-2 max-[900px]:hidden" data-component="ezk-tasks-panel">
        <span class="text-[11px] font-[560] uppercase tracking-wide text-v2-text-text-faint">
          {lt()("tasks.title")} · {t()("tasks.count", { n: runningCount(rows()) })}
        </span>
        <EzkTasksList
          rows={rows()}
          lang={props.lang}
          openId={open()?.id}
          output={open()?.output}
          onToggle={async (r) => {
            if (open()?.id === r.id) return setOpen(undefined)
            const o = await api().output(r.id, props.sessionID ?? "").catch(() => ({ id: r.id, output: r.lastLines.join("\n") }))
            setOpen({ id: r.id, output: o.output.trimEnd().split("\n").slice(-60).join("\n") })
          }}
          onStop={async (r) => {
            const confirmed = await confirmAction(dialog, {
              title: language.t("ezk.action.stop.title"),
              message: language.t("ezk.action.stop.message"),
              confirm: language.t("ezk.action.stop.confirm"),
            })
            if (!confirmed) return
            try {
              await api().stop(r.id, props.sessionID ?? "")
              await refetch()
              showToast({ variant: "success", title: language.t("ezk.action.stop.success") })
            } catch {
              showToast({ variant: "error", title: language.t("ezk.action.stop.failed") })
            }
          }}
        />
      </div>
    </Show>
  )
}
