import { createSignal, onMount, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { bugReportFilename } from "@opencode-ai/core/ezk/diag/report-file"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { EzkConnection } from "./client"
import { fetchBugReport } from "./bugreport-client"

export function DialogBugReport(props: { conn: EzkConnection; fetch?: typeof fetch }) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const isID = () => language.locale() === "id"
  const t = language.t as (key: string) => string
  const [report, setReport] = createSignal("")
  const [error, setError] = createSignal("")
  const [status, setStatus] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  onMount(() => {
    void fetchBugReport(props.conn, props.fetch).then(setReport, () => setError(t("ezk.bugReport.loadFailed")))
  })

  async function copy() {
    try {
      await navigator.clipboard.writeText(report())
      setStatus(t("ezk.bugReport.copied"))
    } catch {
      setStatus(t("ezk.bugReport.copyFailed"))
    }
  }

  async function save() {
    if (!report() || busy()) return
    setBusy(true)
    try {
      if (platform.saveTextFileDialog) {
        const saved = await platform.saveTextFileDialog({
          title: t("ezk.bugReport.saveTitle"),
          defaultPath: bugReportFilename(new Date()),
          content: report(),
        })
        if (saved) setStatus(t("ezk.bugReport.saved"))
      } else {
        const blob = new Blob([report()], { type: "text/plain;charset=utf-8" })
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.href = url
        link.download = bugReportFilename(new Date())
        link.click()
        URL.revokeObjectURL(url)
        setStatus(t("ezk.bugReport.saved"))
      }
    } catch {
      setStatus(t("ezk.bugReport.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("ezk.bugReport.title")}
      description={t("ezk.bugReport.description")}
      size="large"
      class="w-[min(calc(100vw-40px),780px)]"
    >
      <section data-component="ezk-bugreport-dialog" class="flex min-h-0 flex-col gap-3 px-5 pb-5">
        <p class="text-[12px] text-v2-state-fg-warning">{t("ezk.bugReport.reminder")}</p>
        <ShowReport error={error} report={report} t={t} />
        <textarea
          aria-label={t("ezk.bugReport.reportText")}
          class="h-[min(52vh,520px)] min-h-48 w-full resize-y overflow-auto rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-03 p-3 font-mono text-[11px] leading-5 text-v2-text-text-base"
          value={report()}
          readOnly
        />
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="small" onClick={copy} disabled={!report()}>
            {isID() ? "Salin" : "Copy"}
          </Button>
          <Button variant="secondary" size="small" onClick={save} disabled={!report() || busy()}>
            {isID() ? "Simpan file" : "Save file"}
          </Button>
          <Button variant="primary" size="small" onClick={() => platform.openExternal(EZK.supportGroupUrl)}>
            {isID() ? "Buka grup WhatsApp" : "Open WhatsApp group"}
          </Button>
          <span class="min-w-0 flex-1 text-[12px] text-v2-text-text-muted" role="status">
            {status()}
          </span>
        </div>
        <Button variant="ghost" size="small" onClick={() => dialog.close()}>
          {isID() ? "Tutup" : "Close"}
        </Button>
      </section>
    </Dialog>
  )
}

function ShowReport(props: { error: () => string; report: () => string; t: (key: string) => string }) {
  return (
    <Show
      when={props.error()}
      fallback={
        <Show when={!props.report()}>
          <div class="text-[13px] text-v2-text-text-muted">{props.t("ezk.bugReport.loading")}</div>
        </Show>
      }
    >
      <div role="alert" class="text-[13px] text-v2-state-fg-danger">{props.error()}</div>
    </Show>
  )
}
