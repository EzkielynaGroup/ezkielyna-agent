import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

const suggestions = [
  { id: "bug", icon: "bug", prompt: "code" },
  { id: "test", icon: "flask", prompt: "data" },
  { id: "explain", icon: "code", prompt: "general" },
  { id: "feature", icon: "wand", prompt: "ideas" },
] as const

export function HomeSuggestions(props: { onPick: (prompt: (typeof suggestions)[number]["prompt"]) => void }) {
  const language = useLanguage()

  return (
    <div class="ezk-home-suggestions" role="list" aria-label={language.t("ezk.home.suggestions.label")}>
      <For each={suggestions}>
        {(item) => (
          <button class="ezk-home-suggestion" type="button" role="listitem" onClick={() => props.onPick(item.prompt)}>
            <span class="ezk-home-suggestion-icon" aria-hidden="true">
              <IconV2 name={item.icon} />
            </span>
            <span class="ezk-home-suggestion-copy">
              <span class="ezk-home-suggestion-title">{language.t(`ezk.home.suggestion.${item.id}.title`)}</span>
              <span class="ezk-home-suggestion-detail">{language.t(`ezk.home.suggestion.${item.id}.detail`)}</span>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}
