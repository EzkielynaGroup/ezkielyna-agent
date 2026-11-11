// Ezkielyna Agent v1.1: JSON contracts shared by the core, the server routes and the two renderers (TUI, Desktop).
// Renderers only display these payloads; no routing/memory logic lives in the UI.

/** Virtual model id of the client-side router. It is rewritten to a real model per user message. */
export const EZK_AUTO_MODEL_ID = "ezk-auto"
/** What the pickers call it: one language per label (English "Auto (smart)", Indonesian "Otomatis (Pintar)"), never a mix. */
export const EZK_AUTO_MODEL_NAME = { en: "Auto (smart)", id: "Otomatis (Pintar)" } as const
/** Hidden, capability-gated Claude routing entry (D5: deferred). Never registered unless the capability check passes. */
export const EZK_AUTO_PRO_MODEL_ID = "ezk-auto-pro"

export type Tier = "heavy" | "light"

export type RouteMode =
  /** the router picked the model */
  | "auto"
  /** the user picked a concrete model: router stands down */
  | "pinned"
  /** the user picked a gateway alias (default-model, auto, ...): the gateway decides, router stands down */
  | "alias"

export interface RouteInfo {
  mode: RouteMode
  /** The model that serves (or served) the turn. Updated when a fallback or escalation switches it. */
  model: string
  tier?: Tier
  /** Human readable reason, already in English ("light (score 8: short prompt)"). */
  reason: string
  estUSD?: number
  /** Set when the cost cap forced the cheaper model. */
  downgraded?: boolean
  /** Kept the previous model on purpose so the provider prompt cache stays valid. */
  sticky?: boolean
  /** Set when a request failed and the router moved to the next model in the chain. */
  fallbackFrom?: string
  fallbackReason?: string
  /** Set when a failing loop pushed the turn to the heavy tier mid-turn. */
  escalatedFrom?: string
  at: number
}

export interface RouteTurn {
  sessionID: string
  /** User message id; assistant messages carry it as parentID. */
  messageID: string
  route: RouteInfo
}

export interface BreakerEntry {
  model: string
  openUntil: number
  reason: string
}

export interface RouterStatus {
  enabled: boolean
  /** Gateway aliases present in the key's model list (opaque; the gateway decides what they mean). */
  aliases: string[]
  allowed: string[]
  breakers: BreakerEntry[]
  capUSD: number
  spentUSD: number
  /** Claude routing scaffold: false everywhere in v1.1 (hidden). */
  proVisible: boolean
}

export interface MemoryEntryView {
  store: "memory" | "user"
  text: string
}

export interface MemoryStatus {
  enabled: boolean
  /** The first-use notice ("memory is on, local only, you can erase it") has been dismissed. */
  noticeAccepted: boolean
  /** Memory is off for this session (no block, no writes, not searchable). */
  private: boolean
  reviewEnabled: boolean
  memory: { chars: number; limit: number; entries: string[] }
  user: { chars: number; limit: number; entries: string[] }
  dir: string
  /** Active memory/search profile, used to verify isolated Telegram server connections. */
  profile?: string
  lastReview?: { at: number; applied: number; rejected: string[]; model?: string; tokens?: number; error?: string }
}

export interface SearchHit {
  /** filled by the server from the sessions table */
  title?: string
  directory?: string
  sessionID: string
  messageID: string
  role: string
  snippet: string
  rank: number
  time: number
}
