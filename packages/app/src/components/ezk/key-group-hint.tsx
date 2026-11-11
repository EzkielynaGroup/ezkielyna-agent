import { createMemo, Show } from "solid-js"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { inferKeyGroup, shouldShowKeyGroupTip, type KeyGroupModel } from "@opencode-ai/core/ezk/key-group"
import { useLanguage } from "@/context/language"

const GROUP_LABELS = {
  id: { hemat: "Hemat", standard: "Standard", premium: "Premium", auto: "Auto", flash: "Flash" },
  en: { hemat: "Budget", standard: "Standard", premium: "Premium", auto: "Auto", flash: "Flash" },
} as const

export function KeyGroupHint(props: { models: readonly KeyGroupModel[]; compact?: boolean }) {
  const language = useLanguage()
  const summary = createMemo(() => inferKeyGroup(props.models))
  const lang = () => (language.locale() === "id" ? "id" : "en")
  const ratio = (value: number | undefined) =>
    value === undefined
      ? ""
      : ` (${value.toLocaleString(lang() === "id" ? "id-ID" : "en-US", { maximumFractionDigits: 2 })}×)`
  const compactLabel = createMemo(() => {
    const value = summary()
    if (!value) return ""
    if (value.id === "auto") return language.t("ezk.keyGroup.autoAllModels")
    const count = value.modelCount.toLocaleString(lang() === "id" ? "id-ID" : "en-US")
    return `${GROUP_LABELS[lang()][value.id]}${ratio(value.ratio)} · ${count} ${language.locale() === "id" ? "model" : "models"}`
  })

  return (
    <div data-component="key-group-hint" class="flex min-w-0 flex-col gap-0.5">
      <Show when={summary()?.id}>
        {(id) => (
          <div data-slot="key-group-summary" data-variant={props.compact ? "pill" : undefined}>
            {props.compact
              ? compactLabel()
              : language.t("ezk.keyGroup.summary", {
                  group: GROUP_LABELS[lang()][id()],
                  ratio: ratio(summary()?.ratio),
                  count: summary()?.modelCount ?? props.models.length,
                })}
          </div>
        )}
      </Show>
      <Show when={shouldShowKeyGroupTip(props.models)}>
        <p data-slot="key-group-tip" class="text-[11px] leading-4 text-v2-text-text-muted">
          {language.t("ezk.keyGroup.tip")}{" "}
          <a
            class="font-medium text-v2-text-text-base underline underline-offset-2"
            href={EZK.storeURL}
            target="_blank"
            rel="noreferrer"
          >
            {language.t("ezk.keyGroup.settings")}
          </a>
        </p>
      </Show>
    </div>
  )
}
