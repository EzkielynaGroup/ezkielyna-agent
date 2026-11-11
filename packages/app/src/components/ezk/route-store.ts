import { createStore, reconcile } from "solid-js/store"
import type { RouteInfo } from "@opencode-ai/core/ezk/contracts"
import { setEzkRouteResolver } from "@opencode-ai/session-ui/ezk-route"
import { type EzkConnection, ezkClient, routeLabel } from "./client"

// Per-session route records for the turn badge. Loaded lazily the first time a session's messages ask for a label and
// refreshed (debounced) while turns are completing. With no connection registered nothing is fetched.
const [routes, setRoutes] = createStore<Record<string, Record<string, RouteInfo>>>({})
const loading = new Map<string, number>()
let conn: EzkConnection | undefined
let lang = "en"

async function load(sessionID: string) {
  if (!conn) return
  try {
    const turns = await ezkClient(conn).turns(sessionID)
    setRoutes(sessionID, reconcile(Object.fromEntries(turns.map((t) => [t.messageID, t.route]))))
  } catch {}
}

function schedule(sessionID: string, delay = 250) {
  if (loading.has(sessionID)) return
  loading.set(sessionID, window.setTimeout(() => {
    loading.delete(sessionID)
    void load(sessionID)
  }, delay))
}

export function useEzkRouteLabels(next: { connection: () => EzkConnection | undefined; language: () => string }) {
  setEzkRouteResolver((sessionID, messageID) => {
    conn = next.connection()
    lang = next.language()
    const known = routes[sessionID]
    if (!known) schedule(sessionID)
    else if (!known[messageID]) schedule(sessionID, 1500) // new turn: its record exists once the router decided
    const r = known?.[messageID]
    return r ? routeLabel(r, lang) : undefined
  })
}

export const refreshEzkRoutes = (sessionID: string) => schedule(sessionID, 50)
