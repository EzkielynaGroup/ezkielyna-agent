type CredentialProvider = { key?: unknown; source?: unknown } | undefined

export function hasEzkielynaCredential(provider: CredentialProvider) {
  if (provider?.source === "env") return true
  return typeof provider?.key === "string" && provider.key.trim().length > 0
}

export function ezkielynaKeyAction(provider: CredentialProvider) {
  if (provider?.source === "config" || provider?.source === "env" || !hasEzkielynaCredential(provider)) return "connect" as const
  return "change" as const
}

/**
 * `credentialKnown` false: the server's provider list carries no key or source (protocol v2 normalises every provider to
 * `source: "custom"`), so "no credential" cannot be told from "unknown" and the dialog must not open on its own.
 */
export function shouldOpenFirstRun(input: {
  ready: boolean
  hasCredential: boolean
  alreadyOpened: boolean
  credentialKnown?: boolean
}) {
  return input.ready && input.credentialKnown !== false && !input.hasCredential && !input.alreadyOpened
}

const BAD_KEY = /invalid, deleted, or out of balance|invalid token|incorrect api key|invalid api key|kunci api (?:tidak valid|sudah dihapus)|no auth (?:found|configured)|no credential|credentials? not found|missing (?:api )?key|api key (?:is )?(?:missing|required)|\/connect\b/i

export function classifyDesktopEzkKeyError(message: string, hasCredential: boolean) {
  if (!BAD_KEY.test(message)) return
  return hasCredential ? "invalid-key" as const : "missing-key" as const
}
