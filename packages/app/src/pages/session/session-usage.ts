import type { Session } from "@opencode-ai/sdk/v2"

export type SessionUsage = {
  totalTokens: number
  cacheHitPercent?: number
}

export function sessionUsage(tokens: Session["tokens"] | undefined): SessionUsage | undefined {
  if (!tokens) return
  const cacheTotal = tokens.cache.read + tokens.cache.write
  const promptTotal = tokens.input + cacheTotal
  return {
    totalTokens: tokens.input + tokens.output + cacheTotal,
    cacheHitPercent: promptTotal > 0 ? (tokens.cache.read / promptTotal) * 100 : undefined,
  }
}
