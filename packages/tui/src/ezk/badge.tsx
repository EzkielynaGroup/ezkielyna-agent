import { createEffect, Show } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { routeLabel } from "./api"
import { refreshRoutes, routeFor } from "./route-store"

/** Inline span for the assistant footer: shows how the model of this turn was chosen. Renders nothing when unknown. */
export function RouteBadge(props: { sessionID: string; parentID: string; done: boolean }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  createEffect(() => {
    // refetch when the turn completes (fallback / escalation details are recorded while it runs)
    if (props.done || !routeFor(props.sessionID, props.parentID)) void refreshRoutes({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers }, props.sessionID)
  })
  const route = () => routeFor(props.sessionID, props.parentID)
  return (
    <Show when={route()}>
      {(r) => <span style={{ fg: r().fallbackFrom || r().escalatedFrom || r().downgraded ? theme.warning : theme.textMuted }}> · {routeLabel(r())}</span>}
    </Show>
  )
}
