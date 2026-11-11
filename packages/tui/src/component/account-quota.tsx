import type { RGBA } from "@opentui/core"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { accountLine, loadAccountStatus } from "@opencode-ai/core/ezkielyna-account"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { readLocalKey } from "@opencode-ai/core/ezkielyna-localkey"
import { useTheme } from "../context/theme"

// Ezkielyna Agent: plan name + remaining quota (or balance) in the footer, from the store /me endpoint with the gateway
// billing fallback. Refreshed once a minute (the server allows 20 requests a minute per key); nothing is shown when there
// is no key or no network, and a failed refresh keeps the last value.
export function AccountQuota(props: { color?: RGBA }) {
  const { theme } = useTheme()
  const [line, setLine] = createSignal<string>()
  onMount(() => {
    const lang = detectLang()
    let stopped = false
    const load = async () => {
      const key = readLocalKey()
      if (!key) return setLine(undefined)
      const status = await loadAccountStatus(key, fetch, AbortSignal.timeout(8000)).catch(() => undefined)
      if (!stopped && status) setLine(accountLine(status, lang) || undefined)
    }
    void load()
    const timer = setInterval(() => void load(), 60_000)
    onCleanup(() => {
      stopped = true
      clearInterval(timer)
    })
  })
  return (
    <Show when={line()}>
      <text fg={props.color ?? theme.textMuted}>{line()}</text>
    </Show>
  )
}
