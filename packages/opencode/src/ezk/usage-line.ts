// P4: the one-line usage summary `run` prints at the end (tokens in/out, cached, cost). Pure; the numbers are the same ones
// `exec` reports: in = input + cache read + cache write, cached = cache read, out = output + reasoning, and the cost of
// Ezkielyna models comes from the router price book (the gateway's own price list), other providers report their own cost.
import { costUSD } from "@opencode-ai/core/ezk/pricing"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { detectLang, type Lang } from "@opencode-ai/core/ezkielyna-errors"

export type Tokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
export type Step = { id: string; providerID?: string; modelID?: string; tokens: Tokens; cost: number }
export type Prices = (model: string) => Parameters<typeof costUSD>[0]

export function normalize(tokens: Tokens) {
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cache: { read: tokens.cache?.read ?? 0, write: tokens.cache?.write ?? 0 },
  }
}

/** The router's price book (gateway /api/pricing, cached, static fallback); empty outside the ezk runtime. */
export async function routerPrices(): Promise<Prices> {
  try {
    const { ezkRuntime } = await import("@/plugin/ezk/runtime")
    const book = ezkRuntime().prices
    return (model) => book.get(model)
  } catch {
    return () => undefined
  }
}

/** Collects the completed assistant messages of a run (latest state per message id). */
export class UsageTally {
  private steps = new Map<string, Step>()

  seen(info: any) {
    if (!info || info.role !== "assistant" || !info.time?.completed) return
    this.steps.set(info.id, { id: info.id, providerID: info.providerID, modelID: info.modelID, tokens: info.tokens ?? {}, cost: info.cost ?? 0 })
  }

  get count() {
    return this.steps.size
  }

  totals(prices: Prices = () => undefined) {
    let input = 0
    let cached = 0
    let output = 0
    let cost = 0
    for (const step of this.steps.values()) {
      const t = normalize(step.tokens)
      input += t.input + t.cache.read + t.cache.write
      cached += t.cache.read
      output += t.output + t.reasoning
      cost += step.providerID === EZK.providerID ? costUSD(prices(step.modelID ?? ""), t) : step.cost
    }
    return { input, cached, output, cost, turns: this.steps.size }
  }
}

/** Costs under one cent show four decimals ($0.0042), otherwise two ($1.27). */
export function formatUsd(cost: number): string {
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}

export function usageLine(totals: { input: number; cached: number; output: number; cost: number }, lang: Lang = detectLang()): string {
  const n = (value: number) => value.toLocaleString(lang === "id" ? "id-ID" : "en-US")
  return lang === "id"
    ? `Pemakaian: ${n(totals.input)} token masuk (${n(totals.cached)} dari cache), ${n(totals.output)} keluar, biaya ${formatUsd(totals.cost)}`
    : `Usage: ${n(totals.input)} tokens in (${n(totals.cached)} cached), ${n(totals.output)} out, cost ${formatUsd(totals.cost)}`
}
