import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { createMemo, createResource, createSignal, type Accessor, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerProtocol, useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { DialogConnectProvider, useProviderConnectController } from "../dialog-connect-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { DialogChangeEzkielynaKey } from "../ezk/dialog-change-key"
import { confirmAction } from "../confirm-action"
import { maskedApiKey } from "../ezk/key-validation"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { formatIdr } from "@opencode-ai/core/ezkielyna-account"
import { statusClient } from "../ezk/status-client"
import type { KeyGroupModel } from "@opencode-ai/core/ezk/key-group"
import { KeyGroupHint } from "../ezk/key-group-hint"
import { canDisconnectProvider, providerDisconnectOutcome } from "../ezk/provider-source"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

const PROVIDER_NOTES = [
  { match: (id: string) => id === "opencode", key: "dialog.provider.opencode.note" },
  { match: (id: string) => id === "opencode-go", key: "dialog.provider.opencodeGo.tagline" },
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component<{
  directory: Accessor<string | undefined>
  onBack?: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const protocol = useServerProtocol()
  const serverSync = useServerSync()
  const providers = useProviders(props.directory)
  const providerConnect = useProviderConnectController({ onBack: props.onBack })

  const connect = (provider?: string) => {
    providerConnect.select(provider)
    void dialog.show(() => <DialogConnectProvider directory={props.directory} controller={providerConnect} />)
  }

  const connected = createMemo(() => {
    return providers
      .connected()
      .filter((p) => p.id !== "opencode" || Object.values(p.models).find((m) => m.cost?.input))
  })

  const ezkProvider = createMemo(() => connected().find((provider) => provider.id === EZK.providerID))
  const connection = createMemo(() => {
    const http = serverSdk().server.http
    return { url: http.url, username: http.username, password: http.password }
  })
  const accountSource = createMemo(() => (ezkProvider() ? connection() : undefined))
  const [account, { refetch: refetchAccount }] = createResource(accountSource, (conn) =>
    conn ? statusClient(conn).account().catch(() => ({ state: "unavailable" as const })) : undefined,
  )
  const accountData = createMemo(() => {
    const result = account()
    return result?.state === "available" ? result.account : undefined
  })
  const accountStatusText = createMemo(() =>
    account()?.state === "refused"
      ? language.t("ezk.sidebar.keyRefused")
      : language.t("ezk.sidebar.balanceLoading"),
  )
  const keyGroupModels = createMemo(() => {
    const provider = ezkProvider() as
      | (ProviderItem & { models?: Record<string, KeyGroupModel> })
      | undefined
    return Object.values(provider?.models ?? {})
  })

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const items = providers
      .popular()
      .filter((p) => !connectedIDs.has(p.id))
      .slice()
    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return items
  })

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) =>
    canDisconnectProvider({
      providerID: item.id,
      builtInProviderID: EZK.providerID,
      source: source(item),
      configuredCustomProvider: isConfigCustom(item.id),
      legacyConfigSupported: true,
    })

  const sourceDescription = (item: ProviderItem) => {
    if (source(item) === "env")
      return language.t("provider.disconnect.source.environment", { name: item.id === EZK.providerID ? EZK.envKey : item.env.join(", ") })
    if (source(item) === "config")
      return language.t("provider.disconnect.source.config", {
        path: serverSync().data.path.config || language.t("provider.disconnect.configFile"),
      })
    return language.t("settings.providers.connected.environmentDescription")
  }

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key
  const [disconnecting, setDisconnecting] = createSignal<string[]>([])

  const changeKey = () =>
    void dialog.push(() => (
      <DialogChangeEzkielynaKey
        refresh={async () => {
          await serverSync().refreshProviders()
          await refetchAccount()
        }}
      />
    ))

  const isConfigCustom = (providerID: string) => {
    const provider = serverSync().data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  const disableProvider = async (providerID: string, name: string) => {
    if (protocol() !== "v1") return
    const before = serverSync().data.config.disabled_providers ?? []
    const next = before.includes(providerID) ? before : [...before, providerID]
    serverSync().set("config", "disabled_providers", next)

    await serverSync()
      .updateConfig({ disabled_providers: next })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.configured.title", { provider: name }),
          description: language.t("provider.disconnect.configured.description"),
        })
      })
      .catch(() => {
        serverSync().set("config", "disabled_providers", before)
        showToast({ variant: "error", title: language.t("common.requestFailed") })
      })
  }

  const disconnect = async (item: ProviderItem) => {
    if (disconnecting().includes(item.id)) return
    setDisconnecting((items) => [...items, item.id])
    try {
      const confirmed = await confirmAction(dialog, {
        title: language.t("provider.disconnect.confirm.title", { provider: item.name }),
        message: language.t("provider.disconnect.confirm.message"),
        confirm: language.t("common.disconnect"),
      })
      if (!confirmed) return
      if (isConfigCustom(item.id)) {
        await serverSdk().client.auth.remove({ providerID: item.id })
        await disableProvider(item.id, item.name)
        return
      }
      await serverSdk().client.auth.remove({ providerID: item.id })
      await serverSdk().client.global.dispose()
      await serverSync().refreshProviders()
      const next = providers.all().get(item.id) as ProviderItem | undefined
      const outcome = providerDisconnectOutcome({ exists: !!next, source: next && source(next) })
      showToast(
        outcome === "still-configured"
          ? {
              variant: "default",
              title: language.t("provider.disconnect.stillConfigured.title", { provider: item.name }),
              description: language.t("provider.disconnect.stillConfigured.description"),
            }
          : outcome === "disconnected"
            ? {
              variant: "success",
              icon: "circle-check",
              title: language.t("provider.disconnect.toast.disconnected.title", { provider: item.name }),
              description: language.t("provider.disconnect.toast.disconnected.description", { provider: item.name }),
              }
            : {
                variant: "default",
                title: language.t("provider.disconnect.stillConnected.title", { provider: item.name }),
                description: language.t("provider.disconnect.stillConnected.description"),
              },
      )
    } catch {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
    } finally {
      setDisconnecting((items) => items.filter((id) => id !== item.id))
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.providers.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-providers">
        <div class="settings-v2-section" data-component="connected-providers-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
          <SettingsListV2>
            <Show
              when={connected().length > 0}
              fallback={
                <div class="settings-v2-provider-empty">{language.t("settings.providers.connected.empty")}</div>
              }
            >
              <For each={connected()}>
                {(item) => (
                  <Show
                    when={item.id === EZK.providerID}
                    fallback={
                      <div class="settings-v2-provider-row group">
                        <div class="settings-v2-provider-lead">
                          <ProviderIcon
                            id={item.id}
                            width={PROVIDER_ICON_SIZE}
                            height={PROVIDER_ICON_SIZE}
                            class="settings-v2-provider-icon shrink-0"
                          />
                          <div class="settings-v2-provider-main">
                            <span class="settings-v2-provider-name truncate">{item.name}</span>
                            <Tag>{type(item)}</Tag>
                          </div>
                        </div>
                        <Show
                          when={canDisconnect(item)}
                          fallback={<span class="settings-v2-provider-env-hint">{sourceDescription(item)}</span>}
                        >
                          <ButtonV2
                            size="normal"
                            variant="ghost-muted"
                            disabled={disconnecting().includes(item.id)}
                            onClick={() => void disconnect(item)}
                          >
                            {language.t("common.disconnect")}
                          </ButtonV2>
                        </Show>
                      </div>
                    }
                  >
                    <div class="settings-v2-provider-row ezk-provider-card" data-component="ezk-provider-card">
                      <div class="ezk-provider-heading">
                        <ProviderIcon
                          id={item.id}
                          width={28}
                          height={28}
                          class="settings-v2-provider-icon shrink-0"
                        />
                        <div class="ezk-provider-title">
                          <div class="settings-v2-provider-main">
                            <span class="settings-v2-provider-name truncate">{item.name}</span>
                            <Tag>{language.t("ezk.settings.builtin")}</Tag>
                          </div>
                          <div class="ezk-provider-status"><span aria-hidden="true" />{language.t("ezk.settings.connected")}</div>
                        </div>
                      </div>
                      <div class="ezk-provider-facts">
                        <div>
                          <span class="ezk-provider-fact-label">{language.t("ezk.settings.apiKey")}</span>
                          <span class="ezk-provider-fact-value ezk-provider-key">{item.key ? maskedApiKey(item.key) : language.t("ezk.sidebar.keyMissing")}</span>
                        </div>
                        <div>
                          <span class="ezk-provider-fact-label">{language.t("ezk.sidebar.keyGroup")}</span>
                          <Show when={keyGroupModels().length > 0} fallback={<span class="ezk-provider-fact-value">{language.t("ezk.sidebar.keyGroupUnknown")}</span>}>
                            <KeyGroupHint models={keyGroupModels()} compact />
                          </Show>
                        </div>
                        <div>
                          <span class="ezk-provider-fact-label">{language.t("ezk.sidebar.balance")}</span>
                          <span class="ezk-provider-fact-value ezk-provider-balance" classList={{ "ezk-provider-balance-status": accountData()?.remainingUsd === undefined }}>
                            {accountData()?.remainingUsd !== undefined ? formatIdr(accountData()!.remainingUsd!) : accountStatusText()}
                          </span>
                        </div>
                      </div>
                      <div class="ezk-provider-actions">
                        <ButtonV2 size="normal" variant="neutral" onClick={changeKey}>
                          {language.t("ezk.keyChange.button")}
                        </ButtonV2>
                        <Show
                          when={canDisconnect(item)}
                          fallback={<span class="settings-v2-provider-env-hint">{sourceDescription(item)}</span>}
                        >
                          <ButtonV2
                            size="normal"
                            variant="danger"
                            class="ezk-provider-disconnect"
                            disabled={disconnecting().includes(item.id)}
                            onClick={() => void disconnect(item)}
                          >
                            {language.t("common.disconnect")}
                          </ButtonV2>
                        </Show>
                        <span class="ezk-provider-local-note">{language.t("ezk.settings.localKeyNote")}</span>
                      </div>
                    </div>
                  </Show>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
          <SettingsListV2>
            <For each={popular()}>
              {(item) => (
                <div class="settings-v2-provider-row">
                  <div class="settings-v2-provider-lead">
                    <ProviderIcon
                      id={item.id}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-provider-icon shrink-0"
                    />
                    <div class="settings-v2-provider-copy">
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name">{item.name}</span>
                        <Show when={item.id === "opencode" || item.id === "opencode-go"}>
                          <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
                        </Show>
                      </div>
                      <Show when={note(item.id)}>
                        {(key) => <p class="settings-v2-provider-description">{language.t(key())}</p>}
                      </Show>
                    </div>
                  </div>
                  <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => connect(item.id)}>
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              )}
            </For>

            <Show when={protocol() === "v1"}>
              <div class="settings-v2-provider-row" data-component="custom-provider-section">
                <div class="settings-v2-provider-lead">
                  <ProviderIcon
                    id="synthetic"
                    width={PROVIDER_ICON_SIZE}
                    height={PROVIDER_ICON_SIZE}
                    class="settings-v2-provider-icon shrink-0"
                  />
                  <div class="settings-v2-provider-copy">
                    <div class="settings-v2-provider-main">
                      <span class="settings-v2-provider-name">{language.t("provider.custom.title")}</span>
                      <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                    </div>
                    <p class="settings-v2-provider-description">
                      {language.t("settings.providers.custom.description")}
                    </p>
                  </div>
                </div>
                <ButtonV2
                  size="normal"
                  variant="neutral"
                  icon="plus"
                  onClick={() => {
                    dialog.show(() => <DialogCustomProvider onBack={dialog.close} onChangeKey={changeKey} />)
                  }}
                >
                  {language.t("common.connect")}
                </ButtonV2>
              </div>
            </Show>
          </SettingsListV2>

          <button type="button" class="settings-v2-providers-view-all" onClick={() => connect()}>
            {language.t("dialog.provider.viewAll")}
          </button>
        </div>
      </div>
    </>
  )
}
