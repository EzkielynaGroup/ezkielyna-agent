import { Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import type { EzkConnection } from "./client"
import { laneClient, laneT } from "./lane-client"
import { EzkTasksList } from "./status-panel"
import { taskRows, type TaskRow } from "./status-model"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { confirmAction } from "@/components/confirm-action"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

// Background tasks dialog (T2): what the agent left running, with runtime, last lines, Stop and the full output. Refreshes every 2 s.
export function DialogEzkTasks(props: { conn: EzkConnection; lang?: string; sessionID?: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const t = laneT(props.lang)
  const api = laneClient(props.conn)
  const [data, { refetch }] = createResource(() => api.tasks(props.sessionID))
  const [open, setOpen] = createSignal<{ id: string; output: string }>()
  const timer = window.setInterval(() => void refetch(), 2_000)
  onCleanup(() => window.clearInterval(timer))
  const rows = createMemo(() => taskRows(data()?.tasks ?? [], Date.now()))

  const toggle = async (row: TaskRow) => {
    if (open()?.id === row.id) return setOpen(undefined)
    const r = await api.output(row.id, props.sessionID ?? "").catch(() => ({ id: row.id, output: row.lastLines.join("\n") }))
    setOpen({ id: row.id, output: r.output.trimEnd().split("\n").slice(-60).join("\n") })
  }
  const stop = async (row: TaskRow) => {
    const confirmed = await confirmAction(dialog, {
      title: language.t("ezk.action.stop.title"),
      message: language.t("ezk.action.stop.message"),
      confirm: language.t("ezk.action.stop.confirm"),
    })
    if (!confirmed) return
    try {
      await api.stop(row.id, props.sessionID ?? "")
      await refetch()
      showToast({ variant: "success", title: language.t("ezk.action.stop.success") })
    } catch {
      showToast({ variant: "error", title: language.t("ezk.action.stop.failed") })
    }
  }

  return (
    <Dialog title={t("tasks.title")}>
      <div class="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pl-6 pr-4 pb-4" data-component="ezk-tasks">
        <span class="text-[12.5px] text-v2-text-text-muted">{t("tasks.sub")}</span>
        <Show when={data()?.enabled !== false} fallback={<span class="text-[13px] text-v2-text-text-muted">{t("tasks.off")}</span>}>
          <EzkTasksList rows={rows()} lang={props.lang} openId={open()?.id} output={open()?.output} onToggle={toggle} onStop={stop} />
        </Show>
      </div>
    </Dialog>
  )
}
