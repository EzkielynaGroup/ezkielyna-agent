// Isolated visual fixture for Lane P1. It uses the real theme, shared UI components and shell styles.
import "../src/index.css"
import "../src/components/settings-v2/settings-v2.css"
import { Show, createSignal, onMount } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider } from "@opencode-ai/ui/context"
import { ThemeProvider, useTheme } from "@opencode-ai/ui/theme/context"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { ToastV2, showToastV2 } from "@opencode-ai/ui/v2/toast-v2"
import { EmptyStateV2 } from "@opencode-ai/ui/v2/empty-state-v2"
import { Mark } from "@opencode-ai/ui/logo"
import { Icon } from "@opencode-ai/ui/icon"
import { LanguageProvider, useLanguage, type Locale } from "../src/context/language"
import { HomeSuggestions } from "../src/components/ezk/home-suggestions"
import { SecretInputV2 } from "../src/components/secret-input-v2"
import type { IconProps } from "@opencode-ai/ui/v2/icon"
import { PlatformProvider, type Platform } from "../src/context/platform"
import { SettingsProvider } from "../src/context/settings"
import { AnimatedCountList, type CountItem } from "@opencode-ai/session-ui/tool-count-summary"
import { SessionTodoDock } from "../src/pages/session/composer/session-todo-dock"
import { EzkTestProfileBadge } from "../src/components/ezk/test-profile-badge"

type Scheme = "light" | "dark"
type Screen = "home" | "first-run" | "providers" | "states" | "counter-accessibility"

const platform: Platform = {
  platform: "web",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
  getTestProfile: async () => ({
    enabled: new URLSearchParams(location.search).get("profile") === "test",
    apiHost: "localhost:4310",
  }),
}

function App() {
  const query = new URLSearchParams(location.search)
  const screen = (query.get("screen") ?? "home") as Screen
  const scheme = query.get("theme") === "dark" ? "dark" : "light"
  const locale: Locale = query.get("lang") === "en" ? "en" : "id"

  return (
    <PlatformProvider value={platform}>
      <LanguageProvider locale={locale}>
        <I18nBridge>
          <ThemeProvider defaultTheme="oc-2">
            <Scene screen={screen} scheme={scheme} />
          </ThemeProvider>
        </I18nBridge>
      </LanguageProvider>
    </PlatformProvider>
  )
}

function I18nBridge(props: { children: import("solid-js").JSX.Element }) {
  const language = useLanguage()
  return (
    <I18nProvider
      value={{ locale: language.intl, layoutLocale: language.layoutLocale, t: language.t, plural: language.plural }}
    >
      {props.children}
    </I18nProvider>
  )
}

function Scene(props: { screen: Screen; scheme: Scheme }) {
  const theme = useTheme()
  onMount(() => {
    theme.setColorScheme(props.scheme)
    const ready = () => ((window as unknown as { ready?: boolean }).ready = true)
    void document.fonts.ready.then(() => requestAnimationFrame(ready))
  })
  return (
    <>
      <Show when={props.screen === "home"}>
        <HomeScreen />
      </Show>
      <Show when={props.screen === "first-run"}>
        <FirstRunScreen />
      </Show>
      <Show when={props.screen === "providers"}>
        <ProvidersScreen />
      </Show>
      <Show when={props.screen === "states"}>
        <StatesScreen />
      </Show>
      <Show when={props.screen === "counter-accessibility"}>
        <CounterAccessibilityScreen />
      </Show>
    </>
  )
}

function Sidebar() {
  const language = useLanguage()
  return (
    <aside
      class="ezk-sidebar flex w-[264px] shrink-0 flex-col gap-3 rounded-[14px] bg-v2-background-bg-layer-01 p-2"
      data-component="ezkielyna-sidebar"
    >
      <button
        type="button"
        class="ezk-sidebar-new-task flex h-9 items-center gap-2 rounded-[10px] px-3 text-[13px] font-semibold"
      >
        <IconV2 name="plus" />
        {language.t("ezk.sidebar.newTask")}
      </button>
      <nav class="flex flex-col gap-1">
        <Nav
          icon="magnifying-glass"
          label={language.locale() === "id" ? "Cari sesi" : "Search sessions"}
          shortcut="⌘K"
        />
        <Nav icon="brain" label={language.locale() === "id" ? "Memori" : "Memory"} />
        <Nav icon="grid-plus" label={language.t("ezk.sidebar.plugins")} />
      </nav>
      <section class="min-h-0 flex-1">
        <div class="flex h-6 items-center px-2 text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint">
          {language.t("ezk.sidebar.projects")}
        </div>
        <button class="polish-project-row" type="button" aria-expanded="true">
          <IconV2 name="folder" size="small" />
          <span>toko-online</span>
          <IconV2 name="chevron-down" size="small" />
        </button>
        <div class="ml-4 border-l border-v2-border-border-muted pl-2 text-[12px] text-v2-text-text-muted">
          <div class="rounded-md px-2 py-1">
            Bug pembayaran kupon <span class="float-right">1 j</span>
          </div>
          <div class="rounded-md px-2 py-1">
            Test keranjang belanja <span class="float-right">Kemarin</span>
          </div>
          <div class="rounded-md px-2 py-1">
            Rapikan halaman checkout <span class="float-right">Sen</span>
          </div>
        </div>
        <button class="polish-project-row" type="button" aria-expanded="true">
          <IconV2 name="folder" size="small" />
          <span>api-pesanan</span>
          <IconV2 name="chevron-down" size="small" />
        </button>
        <div class="ml-4 border-l border-v2-border-border-muted pl-2 text-[12px] text-v2-text-text-muted">
          <div class="rounded-md px-2 py-1">Migrasi tabel pesanan <span class="float-right">Sen</span></div>
          <div class="rounded-md px-2 py-1">Dokumentasi endpoint <span class="float-right">Min</span></div>
        </div>
        <button class="polish-project-row" type="button" aria-expanded="false">
          <IconV2 name="folder" size="small" />
          <span>landing-ekspor</span>
          <IconV2 name="chevron-down" size="small" class="-rotate-90" />
        </button>
      </section>
      <div class="ezk-account-card" data-component="ezk-account-card">
        <div class="ezk-account-head">
          <Mark class="size-7 rounded-[6px]" />
          <span class="flex-1">Ezkielyna</span>
          <EzkTestProfileBadge />
          <IconV2 name="settings-gear" />
        </div>
        <div class="ezk-account-balance-label">
          <span>{language.t("ezk.sidebar.balance")}</span>
          <a>{language.t("ezk.sidebar.topUp")}</a>
        </div>
        <div class="ezk-account-balance">Rp48.750</div>
        <div class="ezk-account-key-group">
          <div class="ezk-account-balance-label">{language.t("ezk.sidebar.keyGroup")}</div>
          <span class="ezk-key-group-value">Auto · semua model</span>
        </div>
      </div>
    </aside>
  )
}

function Nav(props: { icon: IconProps["name"]; label: string; shortcut?: string }) {
  return (
    <button
      type="button"
      class="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
    >
      {props.icon === "brain" ? <Icon name="brain" /> : <IconV2 name={props.icon} />}
      <span class="flex-1">{props.label}</span>
      <Show when={props.shortcut}>
        <kbd class="text-[10px] text-v2-text-text-faint">{props.shortcut}</kbd>
      </Show>
    </button>
  )
}

function HomeScreen() {
  const language = useLanguage()
  const [picked, setPicked] = createSignal("")
  return (
    <div class="polish-frame" data-shot="home">
      <Sidebar />
      <main class="polish-main">
        <div class="polish-topbar">
          <div class="ezk-status-pill-wrap">
            <button class="ezk-status-pill" title="Agent bertanya sebelum mengubah file atau menjalankan perintah">
              <IconV2 name="status" size="small" />
              Folder belum dipercaya
            </button>
            <EzkTestProfileBadge />
          </div>
        </div>
        <div class="ezk-home polish-home">
          <div class="polish-home-column">
            <Mark class="size-14 rounded-[14px]" />
            <h1 class="ezk-home-title">{language.t("ezk.home.headline")}</h1>
            <p class="ezk-home-lead">{language.t("ezk.home.lead")}</p>
            <div class="ezk-home-composer polish-composer">
              <div class="polish-composer-input" data-component="prompt-input">
                Contoh: betulkan bug pembayaran saat kupon 100% dipakai
              </div>
              <div class="polish-composer-actions">
                <button aria-label="Lampirkan file">
                  <IconV2 name="paperclip" />
                </button>
                <button class="polish-mode">
                  <IconV2 name="check" size="small" />
                  Rencana
                </button>
                <span class="flex-1" />
                <button class="polish-mode">
                  Auto <IconV2 name="chevron-down" size="small" />
                </button>
                <button class="polish-send" aria-label="Kirim" type="button">
                  <IconV2 name="arrow-up" />
                </button>
              </div>
            </div>
            <div class="polish-folder-line">
              <div class="polish-folder">
                <IconV2 name="folder" size="small" />
                <strong>toko-online</strong>
                <span>~/proyek/toko-online · main</span>
                <IconV2 name="chevron-down" size="small" />
              </div>
              <div
                class="ezk-home-keyboard-hints"
                aria-label="↵ kirim · ⇧↵ baris baru · / perintah"
                data-testid="home-keyboard-hints"
              >
                <span><kbd>↵</kbd>kirim</span><span aria-hidden="true">·</span>
                <span><kbd>⇧↵</kbd>baris baru</span><span aria-hidden="true">·</span>
                <span><kbd>/</kbd>perintah</span>
              </div>
            </div>
            <HomeSuggestions onPick={setPicked} />
            <output data-picked={picked()} class="sr-only">
              {picked()}
            </output>
          </div>
        </div>
      </main>
    </div>
  )
}

function FirstRunScreen() {
  const language = useLanguage()
  return (
    <div class="polish-modal-scene" data-shot="first-run">
      <div class="polish-modal-backdrop" />
      <div data-component="dialog-v2" data-size="large" data-fit="true">
        <div data-slot="dialog-container">
          <div data-slot="dialog-content" class="ezk-connect-dialog">
            <div data-slot="dialog-header">
              <div class="ezk-connect-brand">
                <Mark class="size-12 rounded-xl" />
                <span>{language.t("ezk.firstRun.step")}</span>
              </div>
              <h1 data-slot="dialog-header-title">{language.t("ezk.firstRun.title")}</h1>
            </div>
            <div data-slot="dialog-body">
              <p>{language.t("ezk.firstRun.description")}</p>
              <div class="flex justify-center gap-2">
                <ButtonV2 variant="neutral">{language.t("ezk.firstRun.getKey")}</ButtonV2>
                <ButtonV2 variant="neutral">{language.t("ezk.firstRun.buyPackage")}</ButtonV2>
              </div>
              <label class="flex flex-col gap-1 text-[12px] font-medium">
                {language.t("provider.connect.apiKey.label", { provider: "Ezkielyna" })}
                <SecretInputV2 class="!w-full" name="apiKey" placeholder="sk-..." value="" />
              </label>
              <div data-slot="dialog-footer">
                <ButtonV2 variant="neutral" autofocus>
                  {language.t("ezk.firstRun.skip")}
                </ButtonV2>
                <ButtonV2 variant="contrast">{language.t("common.save")}</ButtonV2>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ProvidersScreen() {
  const language = useLanguage()
  return (
    <div class="polish-frame" data-shot="providers">
      <Sidebar />
      <main class="polish-main polish-settings">
        <div class="settings-v2-tab-header">
          <h2 class="settings-v2-tab-title">{language.t("settings.providers.title")}</h2>
        </div>
        <div class="settings-v2-tab-body settings-v2-providers">
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
            <div data-component="settings-v2-list">
              <div class="settings-v2-provider-row ezk-provider-card" data-component="ezk-provider-card">
                <div class="ezk-provider-heading">
                  <Mark class="size-7 rounded-md" />
                  <div class="ezk-provider-title">
                    <div class="settings-v2-provider-main">
                      <span class="settings-v2-provider-name">Ezkielyna</span>
                      <span class="provider-tag">{language.t("ezk.settings.builtin")}</span>
                    </div>
                    <div class="ezk-provider-status">
                      <span />
                      {language.t("ezk.settings.connected")}
                    </div>
                  </div>
                </div>
                <div class="ezk-provider-facts">
                  <Fact label={language.t("ezk.settings.apiKey")} value="sk-••••a9F2" mono />
                  <Fact label={language.t("ezk.sidebar.keyGroup")} value="Auto · semua model" pill />
                  <Fact label={language.t("ezk.sidebar.balance")} value="Rp48.750" />
                </div>
                <div class="ezk-provider-actions">
                  <ButtonV2 variant="neutral">{language.t("ezk.keyChange.button")}</ButtonV2>
                  <ButtonV2 variant="danger" class="ezk-provider-disconnect">
                    {language.t("common.disconnect")}
                  </ButtonV2>
                </div>
              </div>
            </div>
          </div>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
            <div data-component="settings-v2-list">
              <div class="settings-v2-provider-row">
                Provider kustom <span class="provider-tag">{language.t("settings.providers.tag.custom")}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="polish-confirm-overlay">
          <div class="polish-confirm-dialog">
            <h2>{language.t("provider.disconnect.confirm.title", { provider: "Ezkielyna" })}</h2>
            <p>{language.t("provider.disconnect.confirm.message")}</p>
            <footer>
              <ButtonV2 variant="neutral" autofocus>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="danger-solid">{language.t("common.disconnect")}</ButtonV2>
            </footer>
          </div>
        </div>
      </main>
    </div>
  )
}

function Fact(props: { label: string; value: string; mono?: boolean; pill?: boolean }) {
  return (
    <div>
      <span class="ezk-provider-fact-label">{props.label}</span>
      <span
        classList={{
          "ezk-provider-fact-value": !props.pill,
          "ezk-provider-key": props.mono,
          "ezk-key-group-value": props.pill,
        }}
      >
        {props.value}
      </span>
    </div>
  )
}

function StatesScreen() {
  const language = useLanguage()
  onMount(() => {
    const expectedError = language.locale() === "id" ? "Permintaan gagal" : "Request failed"
    const waitForLocale = async () => {
      const deadline = Date.now() + 5_000
      while (
        (language.t("common.requestFailed") !== expectedError || !document.querySelector(".toast-v2-region")) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      showToastV2({
        variant: "success",
        title: language.t("ezk.action.memory.notice.dismissed"),
        description: language.t("ezk.action.memory.notice.dismissed"),
      })
      showToastV2({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("ezk.keyChange.failed"),
      })
    }
    void waitForLocale()
  })
  return (
    <div class="polish-states" data-shot="states">
      <header>
        <Mark class="size-8 rounded-lg" />
        <span>Ezkielyna Agent · {language.locale() === "id" ? "Info & keadaan kosong" : "Info and empty states"}</span>
      </header>
      <div
        class="ezk-memory-info-bar flex min-w-0 items-center gap-2 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5 text-[11px] text-v2-text-text-muted"
        data-component="ezk-memory-notice"
        role="status"
      >
        <Icon name="brain" size="small" />
        <span class="min-w-0 flex-1 truncate">
          {language.locale() === "id" ? "Memori aktif. Buka menu Memori." : "Memory on. Open Memory to review."}
        </span>
        <button
          type="button"
          class="shrink-0 rounded px-1 text-[14px] leading-none text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"
          aria-label={language.locale() === "id" ? "Tutup" : "Dismiss"}
        >
          ×
        </button>
      </div>
      <section class="polish-state-grid">
        <EmptyStateV2
          icon="workspace"
          title={language.t("ezk.empty.sessions.title")}
          description={language.t("ezk.empty.sessions.description")}
          action={{ label: language.t("ezk.empty.sessions.action"), onClick: () => undefined }}
        />
        <EmptyStateV2
          size="compact"
          title={language.t("ezk.empty.sessions.title")}
          description={language.t("ezk.empty.sessions.description")}
        />
      </section>
      <ToastV2.Region />
    </div>
  )
}

function CounterAccessibilityScreen() {
  const language = useLanguage()
  const items: CountItem[] = [
    { key: "ui.messagePart.context.read", count: 1 },
    { key: "ui.messagePart.context.search", count: 1 },
    { key: "ui.messagePart.context.list", count: 1 },
  ]
  const todos = [
    { content: "Periksa aksesibilitas angka", status: "completed", priority: "medium" },
    { content: "Verifikasi dock", status: "pending", priority: "low" },
  ]

  return (
    <main data-shot="counter-accessibility" class="counter-accessibility">
      <button type="button" data-testid="tool-count-summary-button">
        <span>{language.locale() === "id" ? "Selesai menjelajah " : "Finished exploring "}</span>
        <AnimatedCountList items={items} fallback="" />
      </button>
      <SettingsProvider>
        <SessionTodoDock
          todos={todos}
          collapsed={false}
          onToggle={() => undefined}
          collapseLabel="Collapse tasks"
          expandLabel="Expand tasks"
          dockProgress={1}
        />
      </SettingsProvider>
    </main>
  )
}

render(() => <App />, document.getElementById("root")!)
