import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { Checkpoint, RewindMode } from "@opencode-ai/core/ezk/ux/checkpoints"
import type { ApprovalMode } from "@opencode-ai/core/ezk/ux/plan"
import type { EzkConnection } from "./client"
import { type RewindResult, uxClient } from "./ux-client"
import { uxLang, uxT } from "./ux-strings"
import { confirmAction } from "@/components/confirm-action"

// Ezkielyna Agent v3 "ux" lane dialogs for the Desktop: Rewind (per message or /rewind), the plan approval card and
// /handoff. They only render what /ezk/ux/* returns.

const lastUndo = new Map<string, string>()

export function rewindSummary(res: RewindResult, lang?: string) {
  const t = uxT(lang)
  const short = (f: string) => f.split("/").slice(-2).join("/")
  return [
    res.mode === "summarize" ? t("rewind.summarised") : "",
    res.mode === "files" || res.mode === "both" ? t("rewind.restored", { n: res.restored.length }) : "",
    res.mode === "chat" || res.mode === "both" ? t("rewind.chatBack") : "",
    res.skipped.length ? t("rewind.skipped", { n: res.skipped.length, files: res.skipped.map(short).join(", ") }) : "",
    res.warning === "no-snapshot" ? t("rewind.noSnapshot") : "",
  ]
    .filter(Boolean)
    .join(" ")
}

const MODES: { mode: RewindMode; title: "rewind.both" | "rewind.filesOnly" | "rewind.chat" | "rewind.summary"; hint: "rewind.both.hint" | "rewind.filesOnly.hint" | "rewind.chat.hint" | "rewind.summary.hint" }[] = [
  { mode: "both", title: "rewind.both", hint: "rewind.both.hint" },
  { mode: "files", title: "rewind.filesOnly", hint: "rewind.filesOnly.hint" },
  { mode: "chat", title: "rewind.chat", hint: "rewind.chat.hint" },
  { mode: "summarize", title: "rewind.summary", hint: "rewind.summary.hint" },
]

export function DialogEzkRewind(props: {
  conn: EzkConnection
  sessionID: string
  lang?: string
  /** open straight on this message (the per-message Rewind button) */
  messageID?: string
  /** put the text of the rewound message back into the composer */
  onRestorePrompt?: (messageID: string) => void
  onDone?: (text: string, warning: boolean) => void
  /** test hook */
  fetch?: typeof fetch
}) {
  const dialog = useDialog()
  const t = createMemo(() => uxT(props.lang))
  const api = uxClient(props.conn, props.fetch)
  const [data] = createResource(() => api.checkpoints(props.sessionID).catch((e: Error) => ({ error: e.message })))
  const [picked, setPicked] = createSignal<string | undefined>(props.messageID)
  const [error, setError] = createSignal<string>()
  const list = createMemo(() => {
    const d = data()
    return d && !("error" in d) ? d.checkpoints : []
  })
  const current = createMemo(() => list().find((c) => c.messageID === picked()))

  const run = async (cp: Checkpoint, mode: RewindMode) => {
    const confirmed = await confirmAction(dialog, {
      title: t()("rewind.confirm.title"),
      message: t()(`rewind.confirm.${mode}` as "rewind.confirm.both" | "rewind.confirm.files" | "rewind.confirm.chat" | "rewind.confirm.summarize"),
      confirm: t()("rewind.confirm.button"),
    })
    if (!confirmed) return
    const res = await api.rewind({ sessionID: props.sessionID, messageID: cp.messageID, mode, lang: uxLang(props.lang) }).catch((e: Error) => e)
    if (res instanceof Error) return setError(/busy/.test(res.message) ? t()("rewind.busy") : res.message)
    if (mode === "files" && res.undo) lastUndo.set(props.sessionID, res.undo)
    if (mode === "chat" || mode === "both") props.onRestorePrompt?.(cp.messageID)
    props.onDone?.(rewindSummary(res, props.lang), res.skipped.length > 0 || !!res.warning)
    dialog.close()
  }

  const undo = async () => {
    const snapshot = lastUndo.get(props.sessionID)
    if (!snapshot) return
    await api.undo(props.sessionID, snapshot).then(
      () => {
        lastUndo.delete(props.sessionID)
        dialog.close()
      },
      (e: Error) => setError(e.message),
    )
  }

  const time = (at: number) => new Date(at).toLocaleTimeString(props.lang, { timeStyle: "short" })

  return (
    <Dialog title={t()("rewind.title")} description={t()("rewind.sub")}>
      <div class="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pl-6 pr-4 pb-4" data-component="ezk-rewind">
        <Show when={error()}>
          <div class="rounded-[8px] border border-v2-border-border-muted px-3 py-2 text-[13px] text-v2-text-text-base">{error()}</div>
        </Show>
        <Show
          when={current()}
          fallback={
            <>
              <Show when={lastUndo.get(props.sessionID)}>
                <Button variant="secondary" size="small" onClick={undo}>
                  {t()("rewind.undo")}
                </Button>
              </Show>
              <div class="text-[11px] font-[560] uppercase tracking-wide text-v2-text-text-faint">{t()("rewind.pick")}</div>
              <For each={list()} fallback={<span class="text-[13px] text-v2-text-text-faint">{t()("rewind.empty")}</span>}>
                {(cp) => (
                  <button
                    type="button"
                    data-slot="ezk-checkpoint"
                    class="flex flex-col items-start gap-0.5 rounded-[8px] bg-v2-background-bg-layer-03 px-3 py-2 text-left hover:bg-v2-background-bg-layer-01"
                    onClick={() => setPicked(cp.messageID)}
                  >
                    <span class="w-full truncate text-[13px] text-v2-text-text-base">{cp.preview}</span>
                    <span class="text-[12px] text-v2-text-text-muted">
                      {time(cp.at)} · {cp.files.length} {t()("rewind.files")}
                    </span>
                  </button>
                )}
              </For>
            </>
          }
        >
          {(cp) => (
            <>
              <div class="truncate rounded-[8px] bg-v2-background-bg-layer-03 px-3 py-2 text-[13px] text-v2-text-text-base">{cp().preview}</div>
              <For each={MODES}>
                {(m) => {
                  const disabled = () => m.mode === "files" && !cp().snapshot
                  return (
                    <button
                      type="button"
                      data-slot="ezk-rewind-mode"
                      data-mode={m.mode}
                      disabled={disabled()}
                      class="flex flex-col items-start gap-0.5 rounded-[10px] border border-v2-border-border-muted px-3 py-2 text-left hover:bg-v2-background-bg-layer-01 disabled:opacity-50"
                      onClick={() => run(cp(), m.mode)}
                    >
                      <span class="text-[13px] font-[560] text-v2-text-text-base">{t()(m.title)}</span>
                      <span class="text-[12px] text-v2-text-text-muted">{disabled() ? t()("rewind.noSnapshot") : t()(m.hint)}</span>
                    </button>
                  )
                }}
              </For>
            </>
          )}
        </Show>
        <Show when={data() && !("error" in data()!)}>
          <div class="pt-1 text-[12px] text-v2-text-text-faint">
            {t()("rewind.disk")}: {(data() as { diskText: string }).diskText}
          </div>
        </Show>
      </div>
    </Dialog>
  )
}

export function DialogEzkPlan(props: {
  conn: EzkConnection
  sessionID: string
  lang?: string
  plan: string
  onApproved?: (text: string) => void
  onKeepPlanning?: () => void
  fetch?: typeof fetch
}) {
  const dialog = useDialog()
  const t = createMemo(() => uxT(props.lang))
  const api = uxClient(props.conn, props.fetch)
  const [text, setText] = createSignal(props.plan)
  const [editing, setEditing] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const approve = async (mode: ApprovalMode) => {
    setBusy(true)
    const res = await api.approve({ sessionID: props.sessionID, mode, text: text(), lang: uxLang(props.lang) }).catch((e: Error) => e)
    setBusy(false)
    if (res instanceof Error) return setError(res.message)
    props.onApproved?.([t()("plan.approved", { n: res.todos }), res.forced ? t()("plan.forced") : ""].filter(Boolean).join(" "))
    dialog.close()
  }

  return (
    <Dialog title={t()("plan.title")} description={editing() ? t()("plan.editing") : t()("plan.sub")} size="large">
      <div class="flex max-h-[75vh] flex-col gap-3 pl-6 pr-4 pb-4" data-component="ezk-plan">
        <Show
          when={editing()}
          fallback={
            <div class="max-h-[45vh] overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-v2-background-bg-layer-03 p-3 text-[13px] text-v2-text-text-base" data-slot="ezk-plan-text">
              {text()}
            </div>
          }
        >
          <textarea
            data-slot="ezk-plan-editor"
            class="min-h-[40vh] w-full rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3 font-mono text-[13px] text-v2-text-text-base"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            autofocus
          />
        </Show>
        <Show when={error()}>
          <div class="text-[13px] text-v2-text-text-base">
            {t()("failed")}: {error()}
          </div>
        </Show>
        <div class="flex flex-col gap-2">
          <Button variant="primary" disabled={busy() || !text().trim()} onClick={() => approve("auto")} data-action="auto">
            {t()("plan.auto")}
          </Button>
          <span class="px-1 text-[12px] text-v2-text-text-muted">{t()("plan.auto.hint")}</span>
          <Button variant="secondary" disabled={busy() || !text().trim()} onClick={() => approve("ask")} data-action="ask">
            {t()("plan.ask")}
          </Button>
          <span class="px-1 text-[12px] text-v2-text-text-muted">{t()("plan.ask.hint")}</span>
          <div class="flex gap-2 pt-1">
            <Button
              variant="ghost"
              onClick={() => {
                dialog.close()
                props.onKeepPlanning?.()
              }}
              data-action="keep"
            >
              {t()("plan.keep")}
            </Button>
            <Show when={!editing()}>
              <Button variant="ghost" onClick={() => setEditing(true)} data-action="edit">
                {t()("plan.edit")}
              </Button>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

export function DialogEzkHandoff(props: {
  conn: EzkConnection
  sessionID: string
  lang?: string
  onCreated: (res: { sessionID: string; prompt: string; files: string[] }) => void
  fetch?: typeof fetch
}) {
  const dialog = useDialog()
  const t = createMemo(() => uxT(props.lang))
  const api = uxClient(props.conn, props.fetch)
  const [goal, setGoal] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const go = async () => {
    if (!goal().trim() || busy()) return
    setBusy(true)
    const res = await api.handoff(props.sessionID, goal()).catch((e: Error) => e)
    setBusy(false)
    if (res instanceof Error) return setError(res.message)
    dialog.close()
    props.onCreated(res)
  }

  return (
    <Dialog title={t()("handoff.title")} description={t()("handoff.sub")}>
      <div class="flex flex-col gap-3 pl-6 pr-4 pb-4" data-component="ezk-handoff">
        <label class="flex flex-col gap-1 text-[13px] text-v2-text-text-base">
          {t()("handoff.goal")}
          <input
            data-slot="ezk-handoff-goal"
            class="rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 py-2 text-[13px]"
            value={goal()}
            onInput={(e) => setGoal(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && void go()}
            autofocus
          />
        </label>
        <Show when={error()}>
          <div class="text-[13px] text-v2-text-text-base">
            {t()("failed")}: {error()}
          </div>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {t()("cancel")}
          </Button>
          <Button variant="primary" disabled={busy() || !goal().trim()} onClick={go} data-action="handoff">
            {busy() ? t()("handoff.working") : t()("handoff.go")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
