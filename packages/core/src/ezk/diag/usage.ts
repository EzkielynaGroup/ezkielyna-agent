// U4 `/usage` and the status line: tokens, cost and the prompt-cache hit rate of a session, plus the most likely reason
// for cache misses, from the session's own assistant messages (no extra model calls).
export type Step = {
  id: string
  modelID: string
  providerID: string
  tokens: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  costUSD: number
  created: number
  completed?: number
  /** the message is a compaction summary */
  summary?: boolean
}

export type MissCause =
  | "first-request"
  | "not-reported"
  | "model-switch"
  | "idle-expired"
  | "compaction"
  | "prefix-changed"

export type UsageReport = {
  steps: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  costUSD: number
  /** cached share of prompt tokens, 0..100 */
  cacheHitPct: number
  /** cache hit of the last step, 0..100 */
  lastHitPct: number
  missCause?: MissCause
  /** prompt tokens of the last step (what the model saw), for the context % */
  lastPromptTokens: number
  lastModelID?: string
}

/** provider prompt caches typically expire after about five minutes of silence */
export const CACHE_TTL_MS = 5 * 60_000
/** a hit rate below this on the last step is worth explaining */
const LOW_HIT_PCT = 50

export function usageReport(steps: Step[], opts: { prefixChanged?: boolean } = {}): UsageReport {
  const ordered = steps.toSorted((a, b) => a.created - b.created)
  const tokens = ordered.reduce(
    (sum, s) => ({
      input: sum.input + (s.tokens.input ?? 0),
      output: sum.output + (s.tokens.output ?? 0) + (s.tokens.reasoning ?? 0),
      cacheRead: sum.cacheRead + (s.tokens.cache?.read ?? 0),
      cacheWrite: sum.cacheWrite + (s.tokens.cache?.write ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )
  const last = ordered.at(-1)
  return {
    steps: ordered.length,
    tokens,
    costUSD: ordered.reduce((sum, s) => sum + s.costUSD, 0),
    cacheHitPct: hit(tokens.cacheRead, tokens.input + tokens.cacheRead + tokens.cacheWrite),
    lastHitPct: last ? hit(last.tokens.cache?.read ?? 0, prompt(last)) : 0,
    missCause: missCause(ordered, opts),
    lastPromptTokens: last ? prompt(last) : 0,
    lastModelID: last?.modelID,
  }
}

function missCause(steps: Step[], opts: { prefixChanged?: boolean }): MissCause | undefined {
  const last = steps.at(-1)
  if (!last) return undefined
  if (hit(last.tokens.cache?.read ?? 0, prompt(last)) >= LOW_HIT_PCT) return undefined
  if (steps.length === 1) return "first-request"
  if (steps.every((s) => !(s.tokens.cache?.read ?? 0) && !(s.tokens.cache?.write ?? 0))) return "not-reported"
  const previous = steps.at(-2)!
  if (previous.modelID !== last.modelID) return "model-switch"
  if (previous.summary) return "compaction"
  if (last.created - (previous.completed ?? previous.created) > CACHE_TTL_MS) return "idle-expired"
  if (opts.prefixChanged) return "prefix-changed"
  return undefined
}

function prompt(step: Step) {
  return (step.tokens.input ?? 0) + (step.tokens.cache?.read ?? 0) + (step.tokens.cache?.write ?? 0)
}

function hit(read: number, total: number) {
  return total > 0 ? Math.round((read / total) * 1000) / 10 : 0
}

const CAUSES: Record<"en" | "id", Record<MissCause, string>> = {
  en: {
    "first-request": "the first request of a session always starts the cache",
    "not-reported": "this model does not report cached tokens (caching may be off for it)",
    "model-switch": "the model changed; each model keeps its own cache",
    "idle-expired": "more than 5 minutes passed between turns, so the cache expired",
    compaction: "the conversation was just summarized (compacted), which starts a new cache",
    "prefix-changed": "the system prompt or tool list changed between turns",
  },
  id: {
    "first-request": "permintaan pertama sebuah sesi selalu memulai cache dari awal",
    "not-reported": "model ini tidak melaporkan token cache (cache mungkin tidak aktif untuknya)",
    "model-switch": "model berganti; setiap model punya cache sendiri",
    "idle-expired": "jeda antar giliran lebih dari 5 menit, jadi cache kedaluwarsa",
    compaction: "percakapan baru saja diringkas (ringkasan konteks), sehingga cache mulai dari awal",
    "prefix-changed": "prompt sistem atau daftar alat berubah antar giliran",
  },
}

export function missCauseText(cause: MissCause, lang: "en" | "id" = "en") {
  return CAUSES[lang][cause]
}

export function formatUSD(usd: number) {
  if (usd === 0) return "$0"
  return `$${usd.toFixed(usd < 0.1 ? 4 : 2)}`
}

/** The optional TUI footer line: "ctx 34% · $0.0123 · cache 78%". */
export function statusLine(input: { contextPct?: number; costUSD: number; cacheHitPct: number; steps: number }) {
  const parts = [
    ...(input.contextPct !== undefined ? [`ctx ${Math.round(input.contextPct)}%`] : []),
    formatUSD(input.costUSD),
    ...(input.steps ? [`cache ${Math.round(input.cacheHitPct)}%`] : []),
  ]
  return parts.join(" · ")
}
