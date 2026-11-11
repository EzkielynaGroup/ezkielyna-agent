import { createMemo, Show } from "solid-js"
import { getFilename } from "@opencode-ai/core/util/path"
import { formatIdr } from "@opencode-ai/core/ezkielyna-account"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { formatPct, formatTokens, formatUSD } from "@/components/ezk/status-model"
import { sessionUsage } from "./session-usage"
import "./session-polish.css"

export function SessionRunHeader() {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const providers = useProviders(() => sdk().directory)
  const { params } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const assistantMessages = createMemo(() => {
    const messages = params.id ? (sync().data.message[params.id] ?? []) : []
    return messages.filter((message): message is AssistantMessage => message.role === "assistant")
  })
  const assistant = createMemo(() => {
    return assistantMessages().at(-1)
  })
  const model = createMemo(() => {
    const message = assistant()
    if (message) return { providerID: message.providerID, modelID: message.modelID }
    const selected = info()?.model
    if (!selected) return
    return { providerID: selected.providerID, modelID: selected.id }
  })
  const modelName = createMemo(() => {
    const route = model()
    if (!route) return language.t("session.polish.modelUnavailable")
    const provider = providers.all().get(route.providerID)
    return provider?.models[route.modelID]?.name ?? `${route.providerID}/${route.modelID}`
  })
  const usage = createMemo(() => {
    const total = assistantMessages().reduce(
      (sum, message) => ({
        input: sum.input + message.tokens.input,
        output: sum.output + message.tokens.output,
        reasoning: sum.reasoning + message.tokens.reasoning,
        cache: {
          read: sum.cache.read + message.tokens.cache.read,
          write: sum.cache.write + message.tokens.cache.write,
        },
      }),
      { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    )
    const sessionTotal = sessionUsage(info()?.tokens)
    if (sessionTotal && sessionTotal.totalTokens > 0) return sessionTotal
    return sessionUsage(total)
  })
  const totalTokens = createMemo(() => formatTokens(usage()?.totalTokens))
  const cacheHit = createMemo(() => formatPct(usage()?.cacheHitPercent))
  const cacheWidth = createMemo(() => `${Math.max(0, Math.min(100, usage()?.cacheHitPercent ?? 0))}%`)
  const cost = createMemo(() => {
    const reported = info()?.cost
    if (typeof reported === "number" && reported > 0) return reported
    return assistantMessages().reduce((sum, message) => sum + message.cost, 0)
  })
  const directory = createMemo(() => info()?.directory ?? sdk().directory)
  const folder = createMemo(() => getFilename(directory()) || directory())
  const branch = createMemo(() => sync().data.vcs?.branch)

  return (
    <Show when={info()} keyed>
      {(session) => (
        <header class="session-polish-header" data-component="session-run-header">
          <div class="session-polish-header-title">
            <h2>{session.title}</h2>
            <div class="session-polish-header-location">
              <span title={directory()}>{folder()}</span>
              <Show when={branch()}>
                <span aria-hidden="true">·</span>
                <span>{branch()}</span>
              </Show>
            </div>
          </div>
          <div class="session-polish-header-stats" aria-label={language.t("session.polish.usage")}>
            <div class="session-polish-stat session-polish-stat-model">
              <span>{language.t("session.polish.model")}</span>
              <strong title={modelName()}>{modelName()}</strong>
            </div>
            <div class="session-polish-stat">
              <span>{language.t("session.polish.tokens")}</span>
              <strong>{totalTokens()} {language.t("session.polish.tokenUnit")}</strong>
            </div>
            <div class="session-polish-stat session-polish-stat-cache">
              <span>{language.t("session.polish.cache")}</span>
              <strong>{cacheHit()}</strong>
              <span
                class="session-polish-cache-meter"
                role="meter"
                aria-label={language.t("session.polish.cache")}
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={usage()?.cacheHitPercent ?? 0}
              >
                <span style={{ width: cacheWidth() }} />
              </span>
            </div>
            <div class="session-polish-stat session-polish-stat-cost">
              <span>{language.t("session.polish.cost")}</span>
              <strong>{formatUSD(cost())}</strong>
              <span class="session-polish-cost-idr">≈ {formatIdr(cost())}</span>
            </div>
          </div>
        </header>
      )}
    </Show>
  )
}
