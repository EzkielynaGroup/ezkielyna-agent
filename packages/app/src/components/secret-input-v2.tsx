import { TextInputV2, type TextInputV2Props } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { createSignal } from "solid-js"

export type SecretInputV2Props = Omit<TextInputV2Props, "type" | "trailing">

export function SecretInputV2(props: SecretInputV2Props) {
  const language = useLanguage()
  const [visible, setVisible] = createSignal(false)

  return (
    <TextInputV2
      {...props}
      type={visible() ? "text" : "password"}
      autocomplete="off"
      spellcheck={false}
      trailing={
        <button
          type="button"
          data-slot="text-input-v2-icon-button"
          aria-label={language.t(visible() ? "secret.hide" : "secret.show")}
          aria-pressed={visible()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((value) => !value)}
        >
          <Icon name={visible() ? "eye-off" : "eye"} />
        </button>
      }
    />
  )
}
