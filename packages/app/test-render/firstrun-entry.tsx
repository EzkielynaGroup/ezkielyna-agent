import "../src/index.css"
import { render } from "solid-js/web"
import { createSignal, onMount, Show } from "solid-js"
import { LanguageProvider, useLanguage } from "../src/context/language"
import { PlatformProvider, type Platform } from "../src/context/platform"
import { DialogHeader, DialogBody, DialogFooter } from "@opencode-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SecretInputV2 } from "../src/components/secret-input-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { Mark } from "@opencode-ai/ui/logo"
import { Card } from "@opencode-ai/ui/card"
import { ezkT } from "../src/components/ezk/strings"

const platform: Platform = {
  platform: "web",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
}

function FirstRunKey() {
  const language = useLanguage()
  const t = (key: string) => language.t(key)
  return (
    <>
      <div data-component="dialog-overlay" />
      <section data-scene="first-run" data-component="dialog-v2" role="dialog" aria-modal="true">
        <div data-slot="dialog-container">
          <div data-slot="dialog-content">
            <DialogHeader hideClose>
              <h1 data-slot="dialog-header-title">{t("ezk.firstRun.title")}</h1>
            </DialogHeader>
            <DialogBody class="flex flex-col gap-4 px-5 py-3">
              <p class="m-0 text-[13px] text-v2-text-text-muted">{t("ezk.firstRun.description")}</p>
              <div class="flex flex-wrap gap-2">
                <ButtonV2 type="button" variant="neutral" size="small">{t("ezk.firstRun.getKey")}</ButtonV2>
                <ButtonV2 type="button" variant="neutral" size="small">{t("ezk.firstRun.buyPackage")}</ButtonV2>
              </div>
              <label class="flex flex-col gap-1 text-[12px] font-medium text-v2-text-text-base">
                {language.t("provider.connect.apiKey.label", { provider: "Ezkielyna" })}
                <SecretInputV2 class="!w-full" name="apiKey" data-input="firstrun-api-key" value="" autofocus />
              </label>
              <DialogFooter>
                <ButtonV2 type="button" variant="neutral">{t("ezk.firstRun.skip")}</ButtonV2>
                <ButtonV2 type="button" variant="contrast">{language.t("common.save")}</ButtonV2>
              </DialogFooter>
            </DialogBody>
          </div>
        </div>
      </section>
    </>
  )
}

function NoKeySidebar() {
  const language = useLanguage()
  const [opened, setOpened] = createSignal(false)
  return (
    <section data-scene="sidebar" class="flex w-[264px] flex-col gap-2 rounded-[14px] bg-v2-background-bg-layer-01 p-3">
      <div class="flex items-center gap-2 rounded-[10px] bg-v2-background-bg-layer-03 p-2">
        <Mark class="size-7 shrink-0 rounded-[6px]" />
        <div class="min-w-0 flex-1">
          <div class="text-[12.5px] font-[560] text-v2-text-text-base">Ezkielyna</div>
          <div class="truncate text-[11.5px] text-v2-text-text-muted">{language.t("ezk.sidebar.keyMissing")}</div>
        </div>
      </div>
      <ButtonV2 variant="neutral" size="small" onClick={() => setOpened(true)}>{language.t("ezk.firstRun.addKey")}</ButtonV2>
      <Show when={opened()}><div role="status" data-key-dialog-opened="true" class="text-[11px] text-v2-text-text-muted">{language.t("ezk.firstRun.title")}</div></Show>
    </section>
  )
}

function NoKeyChat() {
  const language = useLanguage()
  const [opened, setOpened] = createSignal(false)
  return (
    <section data-scene="chat" class="w-[680px] rounded-[12px] bg-v2-background-bg-base p-5">
      <Card variant="error" class="error-card">
        <div class="flex flex-wrap items-center gap-3" role="alert">
          <span class="min-w-0 flex-1">{language.t("ezk.firstRun.chat.noKey")}</span>
          <ButtonV2 variant="neutral" size="small" onClick={() => setOpened(true)}>{language.t("ezk.firstRun.addKey")}</ButtonV2>
        </div>
      </Card>
      <Show when={opened()}><div role="status" data-key-dialog-opened="true">{language.t("ezk.firstRun.title")}</div></Show>
    </section>
  )
}

function MemoryInfoBar() {
  const language = useLanguage()
  const t = ezkT(language.locale())
  const [visible, setVisible] = createSignal(true)
  return (
    <Show when={visible()}>
      <div data-scene="memory" data-component="ezk-memory-notice" role="status" class="flex w-[264px] items-center gap-2 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5 text-[11px] text-v2-text-text-muted">
        <Icon name="brain" size="small" />
        <span class="min-w-0 flex-1 truncate" title={t("memory.notice")}>{t("memory.notice.inline")}</span>
        <button type="button" aria-label={t("memory.dismiss")} title={t("memory.dismiss")} onClick={() => setVisible(false)}>×</button>
      </div>
    </Show>
  )
}

function Scene() {
  const scene = new URLSearchParams(location.search).get("scene") ?? location.hash.slice(1)
  onMount(() => {
    document.body.setAttribute("data-new-layout", "")
    document.body.style.backgroundColor = "var(--v2-background-bg-deep)"
  })
  const view = () => {
    if (scene === "first-run") return <FirstRunKey />
    if (scene === "sidebar") return <NoKeySidebar />
    if (scene === "chat") return <NoKeyChat />
    return <MemoryInfoBar />
  }
  return (
    <LanguageProvider locale="id">
      <main class="flex min-h-screen items-start justify-center bg-v2-background-bg-deep p-10">{view()}</main>
    </LanguageProvider>
  )
}

render(
  () => (
    <PlatformProvider value={platform}>
      <Scene />
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
