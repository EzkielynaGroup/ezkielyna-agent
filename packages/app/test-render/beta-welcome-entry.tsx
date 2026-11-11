import "../src/index.css"
import { onMount } from "solid-js"
import { render } from "solid-js/web"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { BetaWelcomeCard, DialogBetaHealth } from "../src/components/ezk/beta-welcome"
import { LanguageProvider } from "../src/context/language"
import { PlatformProvider, type Platform } from "../src/context/platform"

const platform: Platform = {
  platform: "web",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
}

const checkRows = [
  { id: "key", status: "fail", label: "Kunci API", detail: "tidak ada. Jalankan ezkielyna sekali untuk mengisinya, atau atur EZKIELYNA_API_KEY." },
  { id: "gateway", status: "warn", label: "Koneksi", detail: "dilewati (belum ada kunci API)" },
  { id: "group", status: "warn", label: "Grup key", detail: "Tambahkan kunci API untuk memeriksa model yang tersedia." },
  { id: "disk", status: "ok", label: "Ruang disk kosong", detail: "34.2 GB" },
  { id: "trust", status: "warn", label: "Folder ini", detail: "belum dipercaya (/Users/test/project): instruksi dan hooks proyek diabaikan." },
] as const
const fetcher = (async () => new Response(JSON.stringify({ checks: checkRows }))) as unknown as typeof fetch

function CardScene() {
  return (
    <LanguageProvider locale="id">
      <main class="min-h-screen bg-v2-background-bg-deep p-8">
        <div class="mx-auto w-[720px] max-w-full rounded-[12px] bg-v2-background-bg-base p-5">
          <BetaWelcomeCard version="1.19.3-ezk.5" onBugReport={() => undefined} onOpenSupport={() => undefined} onHealthCheck={() => undefined} />
        </div>
      </main>
    </LanguageProvider>
  )
}

function OpenHealth() {
  const dialog = useDialog()
  onMount(() => {
    void dialog.show(() => <DialogBetaHealth conn={{ url: "http://127.0.0.1" }} directory="/Users/test/project" fetch={fetcher} />)
    setTimeout(() => ((window as unknown as { ready?: boolean }).ready = true), 250)
  })
  return null
}

function HealthScene() {
  return (
    <LanguageProvider locale="id">
      <DialogProvider>
        <OpenHealth />
      </DialogProvider>
    </LanguageProvider>
  )
}

render(
  () => (
    <PlatformProvider value={platform}>
      {location.hash === "#health" ? <HealthScene /> : <CardScene />}
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
