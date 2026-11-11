// Cost estimate for a task from its token counts. Ezkielyna models report cost 0 in the agent's events (prices are
// not known client-side), so the bench prices tokens itself: with --price when given, else with the gateway price
// table the router uses (packages/core/src/ezk/pricing.ts, STATIC_PRICES). Unknown models use the highest
// configured static rate so they cannot silently reduce the budget estimate.
import { STATIC_PRICES, costUSD } from "../../packages/core/src/ezk/pricing"
import type { Tokens } from "./events"

/** USD per 1M input, cached-input and output tokens. */
export type Rates = { input: number; cached: number; output: number }

export function parsePrice(value?: string): Rates | undefined {
  if (!value) return undefined
  const [input, cached, output] = value.split("/").map(Number)
  if (![input, cached, output].every((item) => Number.isFinite(item) && item! >= 0))
    throw new Error(`--price must look like 0.30/0.03/1.20 (USD per 1M input/cached/output tokens), got ${value}`)
  return { input: input!, cached: cached!, output: output! }
}

export function estimateCost(tokens: Tokens, model: string | undefined, rates?: Rates) {
  if (rates)
    return {
      usd:
        (tokens.input * rates.input +
          tokens.cache_read * rates.cached +
          (tokens.output + tokens.reasoning) * rates.output) /
        1e6,
      source: "--price",
    }
  const id = model?.replace(/^ezkielyna\//, "")
  const price = id ? STATIC_PRICES[id] : undefined
  if (price)
    return {
      usd: costUSD(price, {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.cache_read, write: tokens.cache_write },
      }),
      source: `pricing.ts:${id}`,
    }
  const conservative = Object.entries(STATIC_PRICES)
    .map(([name, candidate]) => ({ name, usd: costUSD(candidate, {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.cache_read, write: tokens.cache_write },
    }) }))
    .sort((a, b) => b.usd - a.usd)[0]
  if (!conservative) return undefined
  return {
    usd: conservative.usd,
    source: `pricing.ts:conservative-max:${conservative.name}`,
  }
}

/** Conservatively price aggregate auto-router usage at the costliest concrete model seen in its decisions. */
export function estimateCostForModels(tokens: Tokens, models: string[], rates?: Rates) {
  const candidates = models.length
    ? models.map((model) => estimateCost(tokens, model, rates))
    : [estimateCost(tokens, undefined, rates)]
  return candidates.filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => b.usd - a.usd)[0]
}
