import { createResource, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

export function EzkTestProfileBadge() {
  const platform = usePlatform()
  const language = useLanguage()
  const [profile] = createResource(() => platform.getTestProfile?.())
  const label = () => (language.locale() === "id" ? "Profil uji" : "Test profile")

  return (
    <Show when={profile()?.enabled}>
      <span
        data-component="ezk-test-profile-badge"
        data-api-host={profile()?.apiHost}
        class="ezk-test-profile-badge"
        role="note"
        title={`${language.locale() === "id" ? "Host API" : "API host"}: ${profile()?.apiHost}`}
      >
        {label()}
      </span>
    </Show>
  )
}
