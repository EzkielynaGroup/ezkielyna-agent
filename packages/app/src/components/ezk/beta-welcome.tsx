import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { BetaHealthCheck } from "@opencode-ai/core/ezk/diag/beta-welcome"
import { shouldShowBetaWelcome } from "@opencode-ai/core/ezk/diag/beta-welcome"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { ServerConnection } from "@/context/server"
import type { EzkConnection } from "./client"
import { betaNotesForVersion } from "./beta-notes"
import { fetchBetaHealth } from "./beta-welcome-client"

const dismissedKey = (version: string) => `ezk.beta.welcome.dismissed.${version}`

function readVersionFlag(key: string) {
  try {
    return localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

function writeVersionFlag(key: string) {
  try {
    localStorage.setItem(key, "1")
  } catch {}
}

function connection(conn: ServerConnection.Any | undefined): EzkConnection | undefined {
  if (!conn) return
  return { url: conn.http.url, username: conn.http.username, password: conn.http.password }
}

export function BetaWelcomeCard(props: {
  version: string
  onBugReport: () => void
  onOpenSupport: () => void
  onHealthCheck: () => void
}) {
  const language = useLanguage()
  const t = language.t as (key: string, params?: Record<string, string | number | boolean>) => string
  const [dismissed, setDismissed] = createSignal(readVersionFlag(dismissedKey(props.version)) ? props.version : undefined)
  const visible = createMemo(() => shouldShowBetaWelcome(props.version, dismissed()))
  const noteKeys = betaNotesForVersion(props.version)

  return (
    <Show when={visible()}>
      <section
        data-component="ezk-beta-welcome-card"
        class="mb-4 rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-4 shadow-[var(--v2-elevation-raised)]"
        aria-labelledby="ezk-beta-welcome-title"
      >
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h2 id="ezk-beta-welcome-title" class="m-0 text-[15px] font-semibold text-v2-text-text-base">
              {t("ezk.beta.title", { version: props.version })}
            </h2>
            <ul class="mb-3 mt-2 list-disc space-y-1 pl-5 text-[12px] leading-5 text-v2-text-text-muted">
              <li>{t("ezk.beta.try.fix")}</li>
              <li>{t("ezk.beta.try.tests")}</li>
              <li>{t("ezk.beta.try.auto")}</li>
            </ul>
          </div>
          <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded-[7px] text-[18px] text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
            aria-label={t("ezk.beta.dismiss")}
            title={t("ezk.beta.dismiss")}
            onClick={() => {
              writeVersionFlag(dismissedKey(props.version))
              setDismissed(props.version)
            }}
          >
            ×
          </button>
        </div>
        <div class="mb-3 rounded-[8px] bg-v2-background-bg-base px-3 py-2">
          <div class="mb-1 text-[11px] font-semibold text-v2-text-text-base">{t("ezk.beta.notes.title")}</div>
          <ul class="m-0 list-disc space-y-0.5 pl-4 text-[11px] leading-4 text-v2-text-text-muted">
            <For each={noteKeys}>{(key) => <li>{t(key)}</li>}</For>
          </ul>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button variant="primary" size="small" onClick={props.onBugReport}>
            {t("ezk.bugReport.title")}
          </Button>
          <Button variant="secondary" size="small" onClick={props.onOpenSupport}>
            {t("ezk.beta.support")}
          </Button>
          <Button variant="secondary" size="small" onClick={props.onHealthCheck}>
            {t("ezk.beta.health.action")}
          </Button>
        </div>
      </section>
    </Show>
  )
}

export function BetaWelcome(props: {
  version: string
  focusedConnection: Accessor<ServerConnection.Any | undefined>
  directory: Accessor<string | undefined>
}) {
  const dialog = useDialog()
  const platform = usePlatform()

  function openBugReport() {
    const conn = connection(props.focusedConnection())
    if (!conn) return
    void import("./bugreport-dialog").then(({ DialogBugReport }) => {
      void dialog.show(() => <DialogBugReport conn={conn} />)
    })
  }

  function openHealthCheck() {
    const conn = connection(props.focusedConnection())
    void dialog.show(() => <DialogBetaHealth conn={conn} directory={props.directory()} />)
  }

  return (
    <>
      <BetaWelcomeCard
        version={props.version}
        onBugReport={openBugReport}
        onOpenSupport={() => void platform.openExternal(EZK.supportGroupUrl)}
        onHealthCheck={openHealthCheck}
      />
    </>
  )
}

export function DialogBetaHealth(props: { conn?: EzkConnection; directory?: string; fetch?: typeof fetch }) {
  const dialog = useDialog()
  const language = useLanguage()
  const t = language.t as (key: string) => string
  const [checks, setChecks] = createSignal<BetaHealthCheck[]>([])
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(true)

  onMount(() => {
    if (!props.conn || !props.directory) {
      setError(t("ezk.beta.health.unavailable"))
      setLoading(false)
      return
    }
    void fetchBetaHealth(props.conn, props.directory, language.locale(), props.fetch)
      .then(setChecks, () => setError(t("ezk.beta.health.failed")))
      .finally(() => setLoading(false))
  })

  return (
    <Dialog title={t("ezk.beta.health.title")} description={t("ezk.beta.health.description")} size="large">
      <section data-component="ezk-beta-health-dialog" class="flex min-h-0 flex-col gap-3 px-5 pb-5">
        <Show when={loading()}>
          <p class="text-[13px] text-v2-text-text-muted">{t("ezk.beta.health.loading")}</p>
        </Show>
        <Show when={error()}>
          <p role="alert" class="text-[13px] text-v2-state-fg-danger">{error()}</p>
        </Show>
        <div class="flex flex-col gap-2">
          <For each={checks()}>
            {(check) => (
              <div class="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 py-2">
                <span
                  aria-hidden="true"
                  class={`row-span-2 mt-0.5 text-[13px] ${check.status === "ok" ? "text-v2-state-fg-success" : check.status === "fail" ? "text-v2-state-fg-danger" : "text-v2-state-fg-warning"}`}
                >
                  {check.status === "ok" ? "✓" : check.status === "fail" ? "×" : "!"}
                </span>
                <strong class="text-[12px] font-semibold text-v2-text-text-base">{check.label}</strong>
                <span class="whitespace-pre-wrap text-[11px] leading-4 text-v2-text-text-muted">{check.detail}</span>
              </div>
            )}
          </For>
        </div>
        <Button variant="secondary" size="small" onClick={() => dialog.close()}>
          {t("ezk.beta.health.close")}
        </Button>
      </section>
    </Dialog>
  )
}
