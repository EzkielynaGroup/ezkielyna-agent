import { createStore, reconcile } from "solid-js/store"
import type { RouteInfo } from "@opencode-ai/core/ezk/contracts"
import { type EzkTransport, ezk } from "./api"

// Per-session route records, loaded on demand and refreshed when an assistant message completes.
const [routes, setRoutes] = createStore<Record<string, Record<string, RouteInfo>>>({})
const inflight = new Map<string, Promise<void>>()

export function routeFor(sessionID: string, userMessageID: string): RouteInfo | undefined {
  return routes[sessionID]?.[userMessageID]
}

export function refreshRoutes(t: EzkTransport, sessionID: string) {
  let p = inflight.get(sessionID)
  if (!p) {
    p = ezk(t)
      .turns(sessionID)
      .then((turns) => setRoutes(sessionID, reconcile(Object.fromEntries(turns.map((x) => [x.messageID, x.route])))))
      .catch(() => {})
      .finally(() => inflight.delete(sessionID))
    inflight.set(sessionID, p)
  }
  return p
}
