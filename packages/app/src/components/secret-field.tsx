import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField, type TextFieldProps } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { createSignal } from "solid-js"

export type SecretFieldProps = Omit<TextFieldProps, "type" | "trailing">

export function SecretField(props: SecretFieldProps) {
  const language = useLanguage()
  const [visible, setVisible] = createSignal(false)

  return (
    <TextField
      {...props}
      type={visible() ? "text" : "password"}
      autocomplete="off"
      spellcheck={false}
      trailing={
        <IconButton
          type="button"
          icon={visible() ? "eye-off" : "eye"}
          variant="ghost"
          aria-label={language.t(visible() ? "secret.hide" : "secret.show")}
          aria-pressed={visible()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((value) => !value)}
        />
      }
    />
  )
}
