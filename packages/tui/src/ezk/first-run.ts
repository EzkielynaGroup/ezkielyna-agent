// Ezkielyna Agent: first start with no credential. The Ezkielyna provider is always listed (with a fallback model list), so
// "no providers" never happens; what matters is whether any provider has a key. Pure so it can be unit-tested.
import { EZK } from "@opencode-ai/core/ezkielyna-brand"

type ProviderLike = { id: string; source?: string; options?: Record<string, unknown> }

/** Same rule as the server's default-model pick (opencode/src/provider/provider.ts ezkConnected). */
export function ezkielynaConnected(provider: ProviderLike | undefined): boolean {
  if (!provider) return false
  return provider.source === "env" || provider.source === "api" || (typeof provider.options?.apiKey === "string" && provider.options.apiKey !== "")
}

/** True when nothing can answer yet: Ezkielyna has no key and no other provider is configured. */
export function needsFirstKey(providers: readonly ProviderLike[]): boolean {
  if (ezkielynaConnected(providers.find((p) => p.id === EZK.providerID))) return false
  return !providers.some((p) => p.id !== EZK.providerID && p.id !== "opencode")
}
