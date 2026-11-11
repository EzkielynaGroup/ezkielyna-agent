import "../src/index.css"
import { render } from "solid-js/web"
import { onMount } from "solid-js"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader } from "@opencode-ai/ui/v2/dialog-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { SecretField } from "../src/components/secret-field"
import { SecretInputV2 } from "../src/components/secret-input-v2"
import { KeyGroupHint } from "../src/components/ezk/key-group-hint"
import { confirmAction } from "../src/components/confirm-action"
import { LanguageProvider } from "../src/context/language"
import { PlatformProvider } from "../src/context/platform"

const fakeKey = "sk-test_fake-1234"
const models = [{ id: "fast-model", groups: ["flash"], groupRatio: { flash: 0.5 } }]

function ProviderCard() {
  return (
    <section data-scene="provider-card" class="w-[660px] rounded-[14px] border border-v2-border-border-muted bg-v2-background-bg-base p-5">
      <div class="mb-4 text-[17px] font-semibold text-v2-text-text-base">Penyedia terhubung</div>
      <div class="flex flex-wrap items-center justify-between gap-4 rounded-[12px] border-b border-v2-border-border-muted py-4">
        <div class="flex min-w-0 items-center gap-3">
          <ProviderIcon id="ezkielyna" class="size-6 shrink-0" />
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-[14px] font-medium text-v2-text-text-base">
              Ezkielyna <span class="rounded-full bg-v2-background-bg-layer-03 px-2 py-0.5 text-[11px] text-v2-text-text-muted">API key</span>
            </div>
            <div class="mt-1 text-[12px] text-v2-text-text-muted">Terhubung · API key sk-…1234</div>
            <KeyGroupHint models={models} />
          </div>
        </div>
        <div class="flex items-center gap-2">
          <ButtonV2 variant="ghost-muted">Putuskan</ButtonV2>
          <ButtonV2 variant="neutral">Ganti API key</ButtonV2>
        </div>
      </div>
    </section>
  )
}

function DisconnectPrompt() {
  const dialog = useDialog()
  onMount(() => {
    void confirmAction(dialog, {
      title: "Putuskan Ezkielyna?",
      message: "API key tersimpan akan dihapus dari aplikasi. Pengaturan dari file config atau variabel lingkungan tetap berlaku.",
      confirm: "Putuskan",
    }).then((confirmed) => {
      document.body.dataset.disconnectConfirmed = String(confirmed)
    })
  })
  return <div data-scene="disconnect-confirm" class="min-h-[520px]" />
}

function KeyChange() {
  return (
    <>
      <div data-component="dialog-overlay" />
      <section data-component="dialog-v2" data-size="large" data-scene="change-key">
        <div data-slot="dialog-container">
          <div data-slot="dialog-content" role="dialog" aria-modal="true">
            <DialogHeader hideClose>
              <h2 data-slot="dialog-header-title">Ganti API key Ezkielyna</h2>
            </DialogHeader>
            <DialogBody class="gap-4 px-5 py-4">
              <p class="m-0 text-[13px] text-v2-text-text-muted">Tempel API key baru. Kami akan memeriksa key lalu menyimpannya ke akun ini.</p>
              <label class="flex flex-col gap-1 text-[12px] font-medium text-v2-text-text-base">
                API key Ezkielyna
                <SecretInputV2 class="!w-full" aria-label="API key Ezkielyna" name="apiKey" value="" />
              </label>
              <div class="rounded-[8px] bg-v2-background-bg-layer-02 px-3 py-2">
                <div class="text-[12px] text-v2-text-text-base">Key tersimpan: sk-…1234</div>
                <KeyGroupHint models={models} />
              </div>
            </DialogBody>
            <DialogFooter>
              <ButtonV2 variant="neutral" autofocus>Batal</ButtonV2>
              <ButtonV2 variant="contrast">Simpan</ButtonV2>
            </DialogFooter>
          </div>
        </div>
      </section>
    </>
  )
}

function CustomProvider() {
  return (
    <section data-scene="custom-provider" role="dialog" class="w-[660px] rounded-[14px] border border-v2-border-border-muted bg-v2-background-bg-base p-5 shadow-xl">
      <h1 class="m-0 text-[17px] font-semibold text-v2-text-text-base">Tambah penyedia kustom</h1>
      <p class="mt-2 text-[13px] text-v2-text-text-muted">Sambungkan penyedia yang kompatibel dengan API OpenAI.</p>
      <div class="mt-4 flex flex-col gap-3">
        <div class="grid grid-cols-2 gap-3">
          <TextField label="Provider ID" value="my-provider" onChange={() => undefined} />
          <TextField label="Nama tampilan" value="Penyedia Saya" onChange={() => undefined} />
        </div>
        <TextField label="Base URL" value="https://api.ezkielyna.store/v1" onChange={() => undefined} />
        <SecretField label="API key" name="apiKey" value={fakeKey} onChange={() => undefined} />
        <div class="flex flex-wrap items-center gap-2 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 py-2 text-[12px] text-v2-text-text-muted">
          <span>Ini provider bawaan. Gunakan Ganti API key.</span>
          <ButtonV2 type="button" size="small" variant="neutral">Ganti API key</ButtonV2>
        </div>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <ButtonV2 variant="neutral">Batal</ButtonV2>
        <ButtonV2 variant="contrast">Sambungkan</ButtonV2>
      </div>
    </section>
  )
}

function Scene() {
  const scene = location.hash.slice(1)
  const content = () => {
    if (scene === "disconnect") {
      return (
        <DialogProvider>
          <DisconnectPrompt />
        </DialogProvider>
      )
    }
    if (scene === "key") return <KeyChange />
    if (scene === "custom") return <CustomProvider />
    return <ProviderCard />
  }
  return (
    <PlatformProvider
      value={{
        platform: "web",
        openExternal: () => undefined,
        restart: async () => undefined,
        notify: async () => undefined,
      }}
    >
      <LanguageProvider locale="id">
        <main class="flex min-h-[640px] items-start justify-center bg-v2-background-bg-deep p-10">{content()}</main>
      </LanguageProvider>
    </PlatformProvider>
  )
}

render(() => <Scene />, document.getElementById("root")!)
