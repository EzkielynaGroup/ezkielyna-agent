// Ezkielyna Agent v1.1: model prices from the public gateway endpoint /api/pricing (1 h cache, static fallback).
// new-api convention: model_ratio 1 == $2 per 1M input tokens (quota_per_unit 500000); output = input x completion_ratio;
// cached input = input x cache_ratio; the user's group multiplies everything (group_ratio).
import fs from "node:fs"
import path from "node:path"
import { STATIC_PRICES } from "./pricing-static"
export { STATIC_PRICES } from "./pricing-static"

export interface Price {
  ratio: number
  completion: number
  cache: number
  /** Cheapest group ratio among the groups that list the model (we cannot see the key's real group). */
  groupRatio: number
}

export const USD_PER_RATIO_MTOK = 2
const TTL_MS = 3600_000

/** Offline fallback: values read from /api/pricing on 2026-10-21. Estimates only. */
export function perMtok(p: Price) {
  const input = p.ratio * USD_PER_RATIO_MTOK * p.groupRatio
  return { input, output: input * p.completion, cachedInput: input * p.cache }
}

/** Parse the /api/pricing payload. Unknown shapes yield an empty table (caller falls back to the static one). */
export function parsePricing(body: unknown): Record<string, Price> {
  const out: Record<string, Price> = {}
  const b = body as { data?: any[]; group_ratio?: Record<string, number> }
  const groups = b?.group_ratio ?? {}
  if (!Array.isArray(b?.data)) return out
  for (const m of b.data) {
    if (typeof m?.model_name !== "string" || typeof m.model_ratio !== "number") continue
    const ratios = (Array.isArray(m.enable_groups) ? m.enable_groups : [])
      .map((g: string) => groups[g])
      .filter((x: unknown): x is number => typeof x === "number")
    out[m.model_name] = {
      ratio: m.model_ratio,
      completion: typeof m.completion_ratio === "number" ? m.completion_ratio : 1,
      cache: typeof m.cache_ratio === "number" ? m.cache_ratio : 1,
      groupRatio: ratios.length ? Math.min(...ratios) : 1,
    }
  }
  return out
}

/** USD for a completed assistant message's token counts. */
export function costUSD(
  p: Price | undefined,
  tokens: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } },
) {
  if (!p) return 0
  const m = perMtok(p)
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0
  return (
    ((tokens.input + cacheWrite) * m.input + cacheRead * m.cachedInput + (tokens.output + (tokens.reasoning ?? 0)) * m.output) /
    1e6
  )
}

/** Rough estimate of one multi-step turn (the prefix is mostly cached after the first step). */
export function estimateTurnUSD(p: Price, promptTokens: number, expectedOut = 1500, steps = 3, cachedFrac = 0.5) {
  const m = perMtok(p)
  let usd = 0
  for (let i = 0; i < steps; i++) {
    const cf = i === 0 ? cachedFrac : Math.max(cachedFrac, 0.8)
    usd += (promptTokens * (1 - cf) * m.input + promptTokens * cf * m.cachedInput + expectedOut * m.output) / 1e6
  }
  return usd
}

export class PriceBook {
  private table: Record<string, Price> = { ...STATIC_PRICES }
  get(model: string): Price | undefined {
    return this.table[model]
  }
  set(table: Record<string, Price>) {
    if (Object.keys(table).length) this.table = { ...STATIC_PRICES, ...table }
  }
}

/** Public, unauthenticated; origin = gateway base URL without `/v1`. Never throws. */
export async function loadPricing(input: {
  baseURL: string
  cacheDir: string
  fetch?: typeof fetch
  now?: number
  timeoutMs?: number
}): Promise<Record<string, Price>> {
  const now = input.now ?? Date.now()
  const file = path.join(input.cacheDir, "ezk-pricing.json")
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as { at: number; table: Record<string, Price> }
    if (now - cached.at < TTL_MS && Object.keys(cached.table).length) return cached.table
  } catch {}
  try {
    const origin = input.baseURL.replace(/\/v1\/?$/, "").replace(/\/+$/, "")
    const res = await (input.fetch ?? fetch)(`${origin}/api/pricing`, { signal: AbortSignal.timeout(input.timeoutMs ?? 4000) })
    if (res.ok) {
      const table = parsePricing(await res.json())
      if (Object.keys(table).length) {
        try {
          fs.mkdirSync(input.cacheDir, { recursive: true })
          fs.writeFileSync(file, JSON.stringify({ at: now, table }), { mode: 0o600 })
        } catch {}
        return table
      }
    }
  } catch {}
  return {}
}
