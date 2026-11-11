import "../src/index.css"
import { render } from "solid-js/web"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { KeyGroupHint } from "../src/components/ezk/key-group-hint"
import { LanguageProvider } from "../src/context/language"
import { PlatformProvider, type Platform } from "../src/context/platform"

const platform: Platform = {
  platform: "web",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
}

const models = ["auto", "hy3", "hy4-preview", "hy4-preview-f"].map((id) => ({
  id,
  groups: ["free"],
  groupRatio: { free: 0.1 },
}))

function AccountCard() {
  return (
    <aside
      data-scene="account-card"
      class="flex w-[264px] items-start gap-2 rounded-[14px] bg-v2-background-bg-layer-01 p-2"
    >
      <div class="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-v2-background-bg-accent text-[13px] font-semibold text-white">
        E
      </div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[12.5px] font-[560] text-v2-text-text-base">Ezkielyna</div>
        <div class="flex items-center gap-1 text-[11.5px] text-v2-text-text-muted">
          <span class="inline-block size-1.5 rounded-full bg-v2-state-fg-success" />
          Kunci API terhubung
        </div>
        <div class="truncate text-[11.5px] text-v2-text-text-faint">Saldo $299 (≈ Rp4.485.000)</div>
        <KeyGroupHint models={models} />
      </div>
      <a
        class="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-v2-icon-icon-base"
        href={EZK.storeURL}
        aria-label="Pengaturan key"
      >
        ⚙
      </a>
    </aside>
  )
}

function ModelDialog() {
  const names = ["Auto", "Hy3", "Hy4 Preview", "Hy4 Preview F"]
  return (
    <section
      data-scene="model-dialog"
      class="w-[600px] overflow-hidden rounded-[14px] border border-v2-border-border-muted bg-v2-background-bg-base shadow-xl"
    >
      <header class="border-b border-v2-border-border-muted px-6 pt-6 pb-4">
        <h1 class="m-0 text-[18px] font-semibold text-v2-text-text-base">Kelola model</h1>
        <p class="mb-0 mt-1 text-[13px] text-v2-text-text-muted">Pilih model yang tersedia untuk sesi baru.</p>
        <div class="mt-3">
          <KeyGroupHint models={models} />
        </div>
      </header>
      <div class="px-6 py-4">
        <div class="mb-3 rounded-md border border-v2-border-border-muted px-3 py-2 text-[13px] text-v2-text-text-faint">
          Cari model
        </div>
        <div class="overflow-hidden rounded-lg border border-v2-border-border-muted">
          {names.map((name, index) => (
            <div class="flex h-11 items-center justify-between border-b border-v2-border-border-muted px-3 last:border-0">
              <span class="text-[13px] text-v2-text-text-base">{name}</span>
              <span class="flex size-5 items-center justify-center rounded border border-v2-border-border-base text-[11px] text-v2-text-text-accent">
                {index === 0 ? "✓" : ""}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Scene(props: { scheme: "light" | "dark"; view: "account" | "model" }) {
  return (
    <div
      data-view={`${props.view}-${props.scheme}`}
      class="flex min-h-[520px] items-start justify-center bg-v2-background-bg-deep p-8"
    >
      {props.view === "account" ? <AccountCard /> : <ModelDialog />}
    </div>
  )
}

render(
  () => (
    <PlatformProvider value={platform}>
      <LanguageProvider locale="id">
        <div class="grid grid-cols-2 gap-6">
          <Scene scheme="light" view="account" />
          <Scene scheme="dark" view="account" />
          <Scene scheme="light" view="model" />
          <Scene scheme="dark" view="model" />
        </div>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
;(window as unknown as { ready: boolean }).ready = true
