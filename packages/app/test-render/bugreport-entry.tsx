import "../src/index.css"
import { onMount } from "solid-js"
import { render } from "solid-js/web"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogBugReport } from "../src/components/ezk/bugreport-dialog"
import { LanguageProvider } from "../src/context/language"
import { PlatformProvider, type Platform } from "../src/context/platform"

const platform: Platform = {
  platform: "desktop",
  openDirectoryPickerDialog: async () => null,
  openExternal: (url) => actionLog.opened.push(url),
  restart: async () => undefined,
  notify: async () => undefined,
  saveTextFileDialog: async (opts) => {
    actionLog.saved.push(opts.content)
    return "/tmp/ezkielyna-laporan.txt"
  },
}
const actionLog = { copied: [] as string[], saved: [] as string[], opened: [] as string[] }
;(window as unknown as { bugReportActions: typeof actionLog }).bugReportActions = actionLog
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (value: string) => void actionLog.copied.push(value) },
})

const sample = [
  "Laporan masalah Ezkielyna Agent",
  "Dibuat: 2026-10-22T02:00:00.000Z",
  "Aplikasi: 1.2.0 (beta)",
  "Sistem: Darwin 25.0 / arm64",
  "Bahasa sistem: id-ID",
  "",
  "Pemeriksaan doctor",
  "OK Versi: 1.2.0",
  "OK Kunci API: ada (tersimpan di komputer ini)",
  "WARN Koneksi: tidak bisa dihubungi (timeout)",
  "",
  "EZK_FEATURES: +diagnostics",
  "Fitur aktif: router.enabled, memory.enabled",
  "Model yang digunakan: ezkielyna/auto",
  "Grup kunci (perkiraan): standard",
  "Kunci API: ada",
  "Disk kosong: 34.2 GB",
  "RAM kosong: 5.1 GB",
  "",
  "Permintaan gagal terakhir: timeout",
  "",
  "Peringatan dan kesalahan terbaru (maks. 50)",
  "WARN connection timeout",
].join("\n")
const fetcher = (async () => new Response(JSON.stringify({ enabled: true, report: sample }))) as typeof fetch

function OpenDialog() {
  const dialog = useDialog()
  onMount(() => {
    void dialog.show(() => (
      <DialogBugReport
        conn={{ url: "http://127.0.0.1" }}
        fetch={fetcher}
      />
    ))
    setTimeout(() => ((window as unknown as { ready?: boolean }).ready = true), 250)
  })
  return null
}

render(
  () => (
    <PlatformProvider value={platform}>
      <LanguageProvider locale="id">
        <DialogProvider>
          <OpenDialog />
        </DialogProvider>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
