// Ezkielyna Agent v1.1: the ONE place that knows model names, tiers and chains (decision D1).
//
// Rule: the gateway decides what an alias ("default-model", "auto", ...) means. The client never copies an alias->target
// mapping; it only (a) knows alias NAMES, taken from the brand constants, and treats them as opaque ids, and (b) decides
// whether to use a named model on top. To change alias behaviour change the gateway, not the agent. If the gateway owner
// publishes a policy document (flag `ezk.router.policyURL`) or the user drops `ezk/model-policy.json` in the config dir,
// it overlays the defaults below; nothing else in the code base hardcodes model ids for routing.
import fs from "node:fs"
import path from "node:path"
import { EZK } from "../ezkielyna-brand"
import type { Tier } from "./contracts"

export interface ModelPolicy {
  version: 1
  /** Gateway aliases, preferred first. Used as the last resort of every chain: the gateway then picks the model. */
  aliasOrder: string[]
  /** Cheap Flash-class models, preferred first. Light tier, cost-cap downgrade target, tiny classifier, reviewer. */
  flash: string[]
  chains: {
    heavy: string[]
    light: string[]
    /** Claude routing, deferred (D5). Only consulted when the capability check passes (see capability.ts). */
    proHeavy: string[]
    proLight: string[]
  }
  /** Models for the memory reviewer (Flash class, never a heavy model). */
  review: string[]
  /** Published group price ratios, used only to explain the key's visible catalog. */
  groupRatio: Record<string, number>
  /** App-facing fields from the version-1 `models` records; unknown document fields remain ignored. */
  models: Record<string, ModelMetadata>
}

export interface ModelMetadata {
  /** App-controlled context window used for context display and compaction. */
  agentContext?: number
  maxOutput?: number
  vision?: boolean
  reasoning?: boolean
  effort?: boolean
  /** Gateway key groups that can access this model (from the existing model-policy document). */
  groups?: string[]
  /** Ratios are copied into the public model metadata so the UI can label an inferred key group. */
  groupRatio?: Record<string, number>
}

export const DEFAULT_POLICY: ModelPolicy = {
  version: 1,
  aliasOrder: ["default-model", "balanced-model", "fast-model", "auto"],
  flash: ["deepseek-v4.1-flash", "minimax-m3.1-flash", "mimo-v2.6-flash", "deepseek-v4.1-flash-1017", "glm-5.3-flash"],
  chains: {
    heavy: ["deepseek-v4-pro-0813", "deepseek-v4.1-flash", "minimax-m3.1-flash", "mimo-v2.6-flash", "glm-5.3-flash"],
    light: ["deepseek-v4.1-flash", "minimax-m3.1-flash", "mimo-v2.6-flash", "deepseek-v4.1-flash-1017", "glm-5.3-flash"],
    proHeavy: ["claude-opus-5.5", "claude-opus-5", "gpt-6-luna"],
    proLight: ["claude-sonnet-5.5", "claude-sonnet-5"],
  },
  review: ["deepseek-v4.1-flash", "minimax-m3.1-flash", "mimo-v2.6-flash"],
  groupRatio: {},
  models: {},
}

const isIdList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && /^[\w.\-:/]{1,80}$/.test(x))

function validGroups(value: unknown) {
  if (!Array.isArray(value)) return
  const groups = value.filter((item): item is string => typeof item === "string" && /^[\w.-]{1,80}$/.test(item))
  return [...new Set(groups)]
}

function validGroupRatios(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const result: Record<string, number> = {}
  for (const [key, ratio] of Object.entries(value as Record<string, unknown>)) {
    if (/^[\w.-]{1,80}$/.test(key) && finiteNonNegative(ratio) && ratio > 0) result[key] = ratio
  }
  return Object.keys(result).length ? result : undefined
}

/** Overlay a (possibly partial, untrusted) policy document on a base policy. Invalid parts are ignored. */
export function mergePolicy(base: ModelPolicy, doc: unknown): ModelPolicy {
  if (!doc || typeof doc !== "object") return base
  const d = doc as Record<string, any>
  const chains = d.chains && typeof d.chains === "object" ? d.chains : {}
  const models = mergeModelMetadata(base.models, d.models)
  return {
    version: 1,
    aliasOrder: isIdList(d.aliasOrder) ? d.aliasOrder : base.aliasOrder,
    flash: isIdList(d.flash) ? d.flash : base.flash,
    chains: {
      heavy: isIdList(chains.heavy) ? chains.heavy : base.chains.heavy,
      light: isIdList(chains.light) ? chains.light : base.chains.light,
      proHeavy: isIdList(chains.proHeavy) ? chains.proHeavy : base.chains.proHeavy,
      proLight: isIdList(chains.proLight) ? chains.proLight : base.chains.proLight,
    },
    review: isIdList(d.review) ? d.review : base.review,
    groupRatio: validGroupRatios(d.groupRatio) ?? base.groupRatio,
    models,
  }
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

function mergeModelMetadata(base: Record<string, ModelMetadata>, raw: unknown): Record<string, ModelMetadata> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base
  const result = { ...base }
  for (const [id, input] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[\w.\-:/]{1,120}$/.test(id) || !input || typeof input !== "object" || Array.isArray(input)) continue
    const item = input as Record<string, unknown>
    const next: ModelMetadata = { ...(result[id] ?? {}) }
    for (const key of ["agentContext", "maxOutput"] as const) {
      if (finiteNonNegative(item[key])) next[key] = item[key]
    }
    if (typeof item.vision === "boolean") next.vision = item.vision
    if (typeof item.reasoning === "boolean") next.reasoning = item.reasoning
    if (typeof item.effort === "boolean") next.effort = item.effort
    const groups = validGroups(item.groups)
    if (groups) next.groups = groups
    if (Object.keys(next).length) result[id] = next
  }
  return result
}

/** Alias ids known to the brand (names only). */
export const knownAliases = (): string[] => Object.keys(EZK.autoModels)
export const isAlias = (id: string) => knownAliases().includes(id)

export interface Allowed {
  ids: Set<string>
  /** Aliases the key can use, in policy preference order. */
  aliases: string[]
}

/** The allowed set is whatever /v1/models returned for THIS key. Nothing outside it is ever routed to. */
export function allowedFrom(ids: Iterable<string>, policy: ModelPolicy = DEFAULT_POLICY): Allowed {
  const set = new Set(ids)
  const known = new Set(knownAliases())
  const order = [...policy.aliasOrder, ...knownAliases()]
  const aliases = [...new Set(order)].filter((a) => set.has(a) && known.has(a))
  return { ids: set, aliases }
}

/** Chain for a tier, filtered by the allowed set, with the gateway alias as the final fallback. */
export function chainFor(policy: ModelPolicy, tier: Tier, allowed: Allowed, opts: { pro?: boolean } = {}): string[] {
  const named = [
    ...(opts.pro ? (tier === "heavy" ? policy.chains.proHeavy : policy.chains.proLight) : []),
    ...policy.chains[tier],
  ]
  const out: string[] = []
  for (const id of [...named, ...allowed.aliases]) if (allowed.ids.has(id) && !out.includes(id)) out.push(id)
  return out
}

/** Cheapest acceptable model for cap downgrades: first allowed Flash model, else the fast alias, else any alias. */
export function cheapestFor(policy: ModelPolicy, allowed: Allowed): string | undefined {
  for (const id of policy.flash) if (allowed.ids.has(id)) return id
  for (const id of ["fast-model", ...allowed.aliases]) if (allowed.ids.has(id)) return id
  return undefined
}

export function reviewerFor(policy: ModelPolicy, allowed: Allowed): string | undefined {
  for (const id of policy.review) if (allowed.ids.has(id)) return id
  return cheapestFor(policy, allowed)
}

/**
 * Policy = defaults, overlaid by the gateway document (cached 24 h, optional) and then by the local file.
 * Never throws and never blocks longer than `timeoutMs`; offline = defaults.
 */
export async function loadPolicy(input: {
  configDir: string
  cacheDir: string
  policyURL?: string
  fetch?: typeof fetch
  now?: number
  timeoutMs?: number
}): Promise<ModelPolicy> {
  let policy = DEFAULT_POLICY
  const now = input.now ?? Date.now()
  if (input.policyURL) {
    const cacheFile = path.join(input.cacheDir, "ezk-model-policy.json")
    let doc: unknown
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { at: number; doc: unknown }
      if (now - cached.at < 24 * 3600_000) doc = cached.doc
    } catch {}
    if (!doc) {
      try {
        const res = await (input.fetch ?? fetch)(input.policyURL, { signal: AbortSignal.timeout(input.timeoutMs ?? 3000) })
        if (res.ok) {
          doc = await res.json()
          try {
            fs.mkdirSync(input.cacheDir, { recursive: true })
            fs.writeFileSync(cacheFile, JSON.stringify({ at: now, doc }), { mode: 0o600 })
          } catch {}
        }
      } catch {}
    }
    policy = mergePolicy(policy, doc)
  }
  try {
    policy = mergePolicy(policy, JSON.parse(fs.readFileSync(path.join(input.configDir, "ezk", "model-policy.json"), "utf8")))
  } catch {}
  return policy
}
