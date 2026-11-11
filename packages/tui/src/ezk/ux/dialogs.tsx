// Ezkielyna Agent v3 "ux" lane dialogs: /rewind (checkpoint, then what goes back), the plan approval card and
// /handoff. They only render what /ezk/ux/* returns; the server decides what is restored or created.
import { createMemo, createResource } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { Checkpoint, RewindMode } from "@opencode-ai/core/ezk/ux/checkpoints"
import type { ApprovalMode } from "@opencode-ai/core/ezk/ux/plan"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useToast } from "../../ui/toast"
import { useTheme } from "../../context/theme"
import { openEditor } from "../../editor"
import type { EzkTransport } from "../api"
import { type RewindResult, ux } from "./api"
import { ut, uxLang } from "./strings"

const transport = (sdk: ReturnType<typeof useSDK>): EzkTransport => ({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers })

/** The snapshot to undo the last files-only rewind, per session (process memory only). */
const lastUndo = new Map<string, string>()

const when = (at: number) => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Step 1 of /rewind: pick the checkpoint (newest first). */
export function DialogRewind(props: { sessionID: string; restorePrompt?: (messageID: string) => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const api = ux(transport(sdk))
  const [data] = createResource(() => api.checkpoints(props.sessionID).catch((e: Error) => ({ error: e.message })))
  dialog.setSize("large")

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const d = data()
    if (!d || "error" in d) return []
    const undo = lastUndo.get(props.sessionID)
    return [
      ...(undo
        ? [
            {
              title: ut("rewind.undo"),
              description: ut("rewind.undo.hint"),
              value: "undo",
              onSelect: async () => {
                await api.undo(props.sessionID, undo).then(
                  () => {
                    lastUndo.delete(props.sessionID)
                    toast.show({ message: ut("rewind.undo"), variant: "success" })
                  },
                  (e: Error) => toast.show({ message: e.message, variant: "error" }),
                )
                dialog.clear()
              },
            } satisfies DialogSelectOption<string>,
          ]
        : []),
      ...d.checkpoints.map((cp) => ({
        title: cp.preview,
        description: `${when(cp.at)} · ${cp.files.length} ${ut("rewind.files")}`,
        value: cp.messageID,
        onSelect: () =>
          dialog.replace(() => <DialogRewindMode sessionID={props.sessionID} checkpoint={cp} restorePrompt={props.restorePrompt} />),
      })),
    ]
  })

  return (
    <DialogSelect
      title={ut("rewind.title")}
      options={options()}
      skipFilter={false}
      emptyView={
        <text fg={theme.textMuted}>{data() && "error" in data()! ? (data() as { error: string }).error : ut("rewind.empty")}</text>
      }
      footer={
        <text fg={theme.textMuted}>
          {data() && !("error" in data()!) ? `${ut("rewind.disk")}: ${(data() as { diskText: string }).diskText}` : ""}
        </text>
      }
    />
  )
}

/** The options of step 2, in display order (exported for tests). */
export function rewindModeOptions(checkpoint: Pick<Checkpoint, "snapshot" | "files">) {
  const modes: { mode: RewindMode; title: string; hint: string; disabled?: boolean }[] = [
    { mode: "both", title: ut("rewind.both"), hint: ut("rewind.both.hint") },
    { mode: "files", title: ut("rewind.filesOnly"), hint: ut("rewind.filesOnly.hint"), disabled: !checkpoint.snapshot },
    { mode: "chat", title: ut("rewind.chat"), hint: ut("rewind.chat.hint") },
    { mode: "summarize", title: ut("rewind.summary"), hint: ut("rewind.summary.hint") },
  ]
  return modes
}

/** Step 2 of /rewind: what goes back. */
export function DialogRewindMode(props: { sessionID: string; checkpoint: Checkpoint; restorePrompt?: (messageID: string) => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const api = ux(transport(sdk))
  dialog.setSize("large")

  const run = async (mode: RewindMode) => {
    const confirmed = await DialogConfirm.show(
      dialog,
      ut("rewind.confirm.title"),
      ut(`rewind.confirm.${mode}` as "rewind.confirm.both" | "rewind.confirm.files" | "rewind.confirm.chat" | "rewind.confirm.summarize"),
      ut("rewind.confirm.button"),
    )
    if (confirmed !== true) {
      dialog.replace(() => <DialogRewindMode {...props} />)
      return
    }
    const res = await api.rewind({ sessionID: props.sessionID, messageID: props.checkpoint.messageID, mode, lang: uxLang() }).catch((e: Error) => e)
    dialog.clear()
    if (res instanceof Error) return toast.show({ message: /busy/.test(res.message) ? ut("rewind.busy") : res.message, variant: "error" })
    toast.show({ message: rewindMessage(res), variant: res.skipped.length || res.warning ? "warning" : "success", duration: 8000 })
    if (mode === "files" && res.undo) lastUndo.set(props.sessionID, res.undo)
    if (mode === "chat" || mode === "both") props.restorePrompt?.(props.checkpoint.messageID)
  }

  return (
    <DialogSelect
      title={`${ut("rewind.mode.title")} — ${props.checkpoint.preview.slice(0, 48)}`}
      skipFilter
      options={rewindModeOptions(props.checkpoint).map((m) => ({
        title: m.title,
        description: m.disabled ? ut("rewind.noSnapshot") : m.hint,
        value: m.mode,
        disabled: m.disabled,
        onSelect: () => void run(m.mode),
      }))}
    />
  )
}

/** Toast text after a rewind (exported for tests). */
export function rewindMessage(res: RewindResult) {
  const short = (f: string) => f.split("/").slice(-2).join("/")
  const lines = [
    res.mode === "summarize" ? ut("rewind.done.summary") : res.mode === "files" ? "" : ut("rewind.done.chat"),
    res.mode === "files" || res.mode === "both" ? ut("rewind.done.files", { n: res.restored.length }) : "",
    res.skipped.length ? ut("rewind.done.skipped", { n: res.skipped.length, files: res.skipped.map(short).join(", ") }) : "",
    res.warning === "no-snapshot" ? ut("rewind.noSnapshot") : "",
  ]
  return lines.filter(Boolean).join(" ")
}

/** The plan approval card: shown once when the plan agent finishes. */
export function DialogPlanApproval(props: { sessionID: string; plan: string; onKeepPlanning?: () => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const renderer = useRenderer()
  const api = ux(transport(sdk))
  dialog.setSize("large")

  const approve = async (mode: ApprovalMode) => {
    const res = await api.approve({ sessionID: props.sessionID, mode, text: props.plan, lang: uxLang() }).catch((e: Error) => e)
    dialog.clear()
    if (res instanceof Error) return toast.show({ message: res.message, variant: "error" })
    toast.show({ message: [ut("plan.approved", { n: res.todos }), res.forced ? ut("plan.forced") : ""].filter(Boolean).join(" "), variant: "success" })
  }

  const edit = async () => {
    const edited = process.env.VISUAL || process.env.EDITOR
      ? await openEditor({ value: props.plan, renderer }).catch(() => undefined)
      : await DialogPrompt.show(dialog, ut("plan.edit.prompt"), { value: props.plan })
    const text = edited?.trim() ? edited : props.plan
    dialog.replace(() => <DialogPlanApproval sessionID={props.sessionID} plan={text} onKeepPlanning={props.onKeepPlanning} />)
  }

  return (
    <DialogSelect
      title={ut("plan.title")}
      skipFilter
      options={planApprovalOptions().map((o) => ({
        title: o.title,
        description: o.hint,
        value: o.value,
        onSelect: () => {
          if (o.value === "auto" || o.value === "ask") return void approve(o.value)
          if (o.value === "edit") return void edit()
          dialog.clear()
          props.onKeepPlanning?.()
        },
      }))}
      footer={<PlanPreview plan={props.plan} />}
    />
  )
}

export function planApprovalOptions() {
  return [
    { value: "auto" as const, title: ut("plan.auto"), hint: ut("plan.auto.hint") },
    { value: "ask" as const, title: ut("plan.ask"), hint: ut("plan.ask.hint") },
    { value: "keep" as const, title: ut("plan.keep"), hint: ut("plan.keep.hint") },
    { value: "edit" as const, title: ut("plan.edit"), hint: ut("plan.edit.hint") },
  ]
}

function PlanPreview(props: { plan: string }) {
  const { theme } = useTheme()
  const lines = createMemo(() => {
    const all = props.plan.split("\n").filter((l) => l.trim())
    return [...all.slice(0, 8), ...(all.length > 8 ? [`… (+${all.length - 8})`] : [])].join("\n")
  })
  return <text fg={theme.textMuted}>{lines()}</text>
}

/** /handoff: ask for the goal, let the server write the starting message, open the new session prefilled. */
export async function runHandoff(deps: {
  sdk: ReturnType<typeof useSDK>
  dialog: ReturnType<typeof useDialog>
  toast: ReturnType<typeof useToast>
  route: ReturnType<typeof useRoute>
  sessionID: string
}) {
  const goal = await DialogPrompt.show(deps.dialog, ut("handoff.goal"), { placeholder: ut("handoff.title") })
  deps.dialog.clear()
  if (!goal?.trim()) return
  deps.toast.show({ message: ut("handoff.working"), variant: "info" })
  const res = await ux(transport(deps.sdk))
    .handoff(deps.sessionID, goal)
    .catch((e: Error) => e)
  if (res instanceof Error) return deps.toast.show({ message: res.message, variant: "error" })
  deps.route.navigate({ type: "session", sessionID: res.sessionID, prompt: { input: res.prompt, parts: [] } })
  deps.toast.show({ message: ut("handoff.done"), variant: "success" })
}
