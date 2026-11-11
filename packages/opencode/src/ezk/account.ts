// Server-only account lookup. Cache and throttle by a one-way key digest; the renderer gets only status and account data.
import { createHash } from "node:crypto"
import { loadAccountLookup, type AccountLookup } from "@opencode-ai/core/ezkielyna-account"
import { readGatewayKey } from "@opencode-ai/core/ezk/key"
import { localCredentialState } from "@opencode-ai/core/ezkielyna-localkey"
import { Global } from "@opencode-ai/core/global"

const CACHE_MS = 60_000
const WINDOW_MS = 60_000
const REQUESTS_PER_MINUTE = 20
const MAX_KEYS = 256

type CacheEntry = { at: number; result: AccountLookup }

export type MissingKeyReason = "keychain-unreadable"

export function createAccountLookupService(input: {
  key: () => string | undefined
  /** Why there is no key, when that is not simply "none saved yet" (the sidebar shows a different hint). */
  missingReason?: () => MissingKeyReason | undefined
  fetch?: typeof fetch
  now?: () => number
}) {
  const cache = new Map<string, CacheEntry>()
  const requests = new Map<string, number[]>()
  const now = input.now ?? Date.now
  const fetcher = input.fetch ?? fetch
  return async function account() {
    const key = input.key()?.trim()
    if (!key) {
      const reason = input.missingReason?.()
      return reason ? ({ state: "missing", reason } as const) : ({ state: "missing" } as const)
    }
    const digest = createHash("sha256").update(key).digest("hex")
    const timestamp = now()
    const cached = cache.get(digest)
    if (cached && timestamp - cached.at < CACHE_MS) return cached.result

    const limitedFetch = (async (resource: URL | RequestInfo, init?: RequestInit) => {
      const requestTime = now()
      const recent = (requests.get(digest) ?? []).filter((at) => requestTime - at < WINDOW_MS)
      if (recent.length >= REQUESTS_PER_MINUTE) return new Response(null, { status: 429 })
      recent.push(requestTime)
      requests.set(digest, recent)
      return fetcher(resource, init)
    }) as typeof fetch
    const result = await loadAccountLookup(key, limitedFetch)
    cache.set(digest, { at: timestamp, result })
    if (cache.size > MAX_KEYS) cache.delete(cache.keys().next().value!)
    if (requests.size > MAX_KEYS) requests.delete(requests.keys().next().value!)
    return result
  }
}

export const accountLookup = createAccountLookupService({
  key: () => readGatewayKey(Global.Path.data),
  missingReason: () =>
    localCredentialState({ dataDir: Global.Path.data }) === "keychain-unreadable" ? "keychain-unreadable" : undefined,
})
