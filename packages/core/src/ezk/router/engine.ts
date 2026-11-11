// Ezkielyna Agent v1.1: the Auto router. Pure state machine, no I/O, no OpenCode imports (the plugin feeds it).
//
// - decide():   once per user message, chooses the model from the key's allowed set (model-policy chains + breaker).
// - escalate(): mid-turn, only on a failing loop, at most twice per message (hook experimental.model.select).
// - next()/noteSwitch(): fallback to the next chain entry after a failed request (used by the routed fetch).
// Switching is sticky on purpose: a model change busts the provider prompt cache, so the router keeps the previous
// model while it is allowed, healthy and in the tier's chain, and returns to the preferred one after STICKY_MS.
import type { RouteInfo, Tier } from "../contracts"
import type { EzkFlags } from "../flags"
import { type Allowed, type ModelPolicy, allowedFrom, chainFor, cheapestFor } from "../model-policy"
import { type PriceBook, estimateTurnUSD } from "../pricing"
import { Breaker } from "./breaker"
import { type TurnSignals, classify } from "./classify"

export const STICKY_MS = 10 * 60_000
export const MAX_ESCALATIONS = 2
const DEFAULT_CONTEXT_TOKENS = 4_000
const SHORT_FOLLOW_UP =
  /^(?:(?:ok(?:ay)?|oke|sip|ya|yes|sure|alright|baik)(?:[, ]+(?:lanjut(?:kan)?|continue|go ahead|proceed|do it|fix it|perbaiki itu))?|lanjut(?:kan)?|continue|go ahead|proceed|do it|fix it|perbaiki itu|oke perbaiki itu)(?:[, ]+(?:with the next step|aja|saja|please|it|itu))?[.! ]*$/i

export type Decision = RouteInfo | { error: string }
export const isError = (d: Decision | undefined): d is { error: string } => !!d && "error" in d

export interface SessionRoute {
  lastModel?: string
  lastTier?: Tier
  lastSwitchAt: number
  contextTokens: number
  spent: Map<string, number>
  escalations: number
  /** user message currently being served (for escalation bookkeeping) */
  messageID?: string
}

export interface EngineOptions {
  policy: ModelPolicy
  prices: PriceBook
  flags: EzkFlags["router"]
  now?: () => number
  /** Capability gate for Claude routing (deferred). Default: never. */
  proEnabled?: () => boolean
}

export class RouterEngine {
  readonly breaker: Breaker
  allowed: Allowed
  policy: ModelPolicy
  private sessions = new Map<string, SessionRoute>()
  private now: () => number

  constructor(private opts: EngineOptions) {
    this.now = opts.now ?? Date.now
    this.breaker = new Breaker(this.now)
    this.policy = opts.policy
    this.allowed = allowedFrom([], opts.policy)
  }

  setAllowed(ids: Iterable<string>) {
    this.allowed = allowedFrom(ids, this.policy)
  }

  setPolicy(policy: ModelPolicy) {
    this.policy = policy
    this.allowed = allowedFrom(this.allowed.ids, policy)
  }

  get capUSD() {
    return this.opts.flags.capUSD
  }

  capReached(sessionID: string) {
    return this.capUSD > 0 && this.spentUSD(sessionID) >= this.capUSD
  }

  capFallback() {
    return cheapestFor(this.policy, this.allowed)
  }

  session(id: string): SessionRoute {
    let s = this.sessions.get(id)
    if (!s) {
      s = { lastSwitchAt: 0, contextTokens: 0, spent: new Map(), escalations: 0 }
      this.sessions.set(id, s)
    }
    return s
  }

  spentUSD(sessionID: string) {
    let total = 0
    for (const v of this.session(sessionID).spent.values()) total += v
    return total
  }

  /** Record (replace) the cost of one assistant message. Idempotent per message id. */
  setMessageCost(sessionID: string, messageID: string, usd: number) {
    this.session(sessionID).spent.set(messageID, usd)
  }

  setContextTokens(sessionID: string, tokens: number) {
    this.session(sessionID).contextTokens = tokens
  }

  forget(sessionID: string) {
    this.sessions.delete(sessionID)
  }

  private pro() {
    return this.opts.proEnabled?.() === true
  }

  private available(tier: Tier): string[] {
    return chainFor(this.policy, tier, this.allowed, { pro: this.pro() }).filter((m) => !this.breaker.isOpen(m))
  }

  decide(
    sessionID: string,
    messageID: string,
    signals: TurnSignals,
    opts: { forced?: Tier; tiny?: Tier; reason?: string } = {},
  ): Decision {
    const s = this.session(sessionID)
    const c = classify({ contextTokens: s.contextTokens, ...signals })
    let tier: Tier = opts.forced ?? c.tier
    let why = opts.reason ?? (opts.forced ? `${tier} (forced by @${tier})` : `${tier} (score ${c.score}: ${c.reasons.join(", ") || "default"})`)
    if (!opts.forced && c.ambiguous && opts.tiny) {
      tier = opts.tiny
      why += `; tiny classifier says ${opts.tiny}`
    }
    if (!opts.forced && s.lastTier && SHORT_FOLLOW_UP.test(signals.prompt.trim())) {
      tier = s.lastTier
      why += "; short follow-up keeps previous tier"
    }
    // Hysteresis: heavy -> light inside a task only when the score is clearly low (cache + quality).
    if (!opts.forced && s.lastTier === "heavy" && tier === "light" && c.score >= 35 && s.lastModel && this.allowed.ids.has(s.lastModel)) {
      tier = "heavy"
      why += "; staying heavy"
    }

    let chain = this.available(tier)
    if (!chain.length) {
      const other: Tier = tier === "heavy" ? "light" : "heavy"
      chain = this.available(other)
      if (chain.length) why += `; no ${tier} model available`
    }
    if (!chain.length) {
      // Everything is marked unavailable: let the best candidate try rather than dead-end.
      const all = chainFor(this.policy, tier, this.allowed, { pro: this.pro() })
      if (!all.length) return { error: "no routable model for this key" }
      chain = [all[0]!]
      why += "; all candidates marked unavailable, trying anyway"
    }

    let model = chain[0]!
    let sticky = false
    if (s.lastModel && s.lastTier === tier && chain.includes(s.lastModel) && s.lastModel !== model) {
      // Same tier, healthy previous model that is not the preferred one (a fallback happened): keep it for a while.
      if (this.now() - s.lastSwitchAt < STICKY_MS) {
        model = s.lastModel
        sticky = true
        why += "; sticky (cache)"
      }
    }

    const price = this.opts.prices.get(model)
    const est = price ? estimateTurnUSD(price, s.contextTokens || DEFAULT_CONTEXT_TOKENS) : undefined
    let downgraded = false
    const cap = this.capUSD
    if (cap > 0) {
      const spent = this.spentUSD(sessionID)
      if (spent >= cap || (est !== undefined && spent + est > cap)) {
        const cheap = cheapestFor(this.policy, this.allowed)
        if (cheap && cheap !== model) {
          model = cheap
          downgraded = true
          sticky = false
          why += spent >= cap ? `; session cap $${cap} reached => ${cheap}` : `; session cap $${cap} => ${cheap}`
        }
      }
    }

    const info: RouteInfo = {
      mode: "auto",
      model,
      tier,
      reason: why,
      estUSD: this.opts.prices.get(model) ? estimateTurnUSD(this.opts.prices.get(model)!, s.contextTokens || DEFAULT_CONTEXT_TOKENS) : undefined,
      ...(downgraded ? { downgraded: true } : {}),
      ...(sticky ? { sticky: true } : {}),
      at: this.now(),
    }
    this.commit(s, model, tier)
    s.escalations = 0
    s.messageID = messageID
    return info
  }

  private commit(s: SessionRoute, model: string, tier: Tier) {
    if (s.lastModel !== model) s.lastSwitchAt = this.now()
    s.lastModel = model
    s.lastTier = tier
  }

  /** Mid-turn: a failing loop pushes a light turn to the heavy tier (at most MAX_ESCALATIONS per message). */
  escalate(sessionID: string, signals: Omit<TurnSignals, "prompt">): RouteInfo | undefined {
    const s = this.session(sessionID)
    if (this.capReached(sessionID)) return
    if (s.lastTier !== "light" || s.escalations >= MAX_ESCALATIONS || !s.lastModel) return
    const c = classify({ prompt: "", contextTokens: s.contextTokens, ...signals })
    if (c.tier !== "heavy" || (signals.failingLoop ?? 0) < 2) return
    const target = this.available("heavy")[0]
    if (!target || target === s.lastModel) return
    const from = s.lastModel
    s.escalations += 1
    this.commit(s, target, "heavy")
    return {
      mode: "auto",
      model: target,
      tier: "heavy",
      reason: `escalated to heavy: ${c.reasons.join(", ")}`,
      escalatedFrom: from,
      at: this.now(),
    }
  }

  /** First healthy chain entry other than `failed`, for the tier the session is on. */
  next(sessionID: string, failed: string): string | undefined {
    const tier = this.session(sessionID).lastTier ?? "light"
    for (const t of [tier, tier === "heavy" ? "light" : "heavy"] as Tier[]) {
      const m = this.available(t).find((x) => x !== failed)
      if (m) return m
    }
    return undefined
  }

  /** The routed fetch moved a request from one model to another: stick to the new one. */
  noteSwitch(sessionID: string, from: string, to: string) {
    const s = this.session(sessionID)
    this.commit(s, to, s.lastTier ?? "light")
    s.lastSwitchAt = this.now()
  }
}
