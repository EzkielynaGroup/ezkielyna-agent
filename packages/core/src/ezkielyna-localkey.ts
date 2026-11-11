// Ezkielyna Agent: finds the user's own Ezkielyna API key for CLI/TUI features that call our two hosts (quota line).
// Order: EZKIELYNA_API_KEY, then auth.json (resolving the keychain sentinel). Node only; the key never leaves this process.
import fs from "node:fs"
import path from "node:path"
import { Global } from "./global"
import { EZK } from "./ezkielyna-brand"
import { SECRET_SENTINEL, createSecretStore, type SecretStore } from "./ezkielyna-secrets"

export function readLocalKey(
  input: {
    dataDir?: string
    env?: Record<string, string | undefined>
    secretStore?: Pick<SecretStore, "get">
  } = {},
): string | undefined {
  const env = input.env ?? process.env
  const fromEnv = env[EZK.envKey]?.trim()
  if (fromEnv) return fromEnv
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(input.dataDir ?? Global.Path.data, "auth.json"), "utf8"),
    ) as Record<string, { type?: string; key?: string }>
    const entry = raw[EZK.providerID]
    if (entry?.type !== "api" || !entry.key) return
    return entry.key === SECRET_SENTINEL ? (input.secretStore ?? createSecretStore()).get("api-key") : entry.key
  } catch {
    return
  }
}

export type LocalCredentialState = "env" | "file" | "keychain" | "keychain-unreadable" | "none"

/**
 * Where the Ezkielyna credential lives, and whether it can actually be read. "keychain-unreadable" is the case the UI
 * must not call "no key": auth.json holds the keychain sentinel but the OS secret store returned nothing (locked
 * keychain, denied prompt, no keyring on Linux, or the 8 s `security` timeout).
 */
export function localCredentialState(
  input: {
    dataDir?: string
    env?: Record<string, string | undefined>
    secretStore?: Pick<SecretStore, "get">
  } = {},
): LocalCredentialState {
  const env = input.env ?? process.env
  if (env[EZK.envKey]?.trim()) return "env"
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(input.dataDir ?? Global.Path.data, "auth.json"), "utf8"),
    ) as Record<string, { type?: string; key?: string }>
    const entry = raw[EZK.providerID]
    if (entry?.type !== "api" || !entry.key) return "none"
    if (entry.key !== SECRET_SENTINEL) return "file"
    return (input.secretStore ?? createSecretStore()).get("api-key") ? "keychain" : "keychain-unreadable"
  } catch {
    return "none"
  }
}

/**
 * Is there any Ezkielyna credential at all? Env var, or an auth.json entry (the keychain sentinel counts; nothing is
 * resolved, so this never opens the OS secret store or prompts). Config-file keys are not visible here: callers that can
 * see the config combine both.
 */
export function hasLocalCredential(
  input: { dataDir?: string; env?: Record<string, string | undefined> } = {},
): boolean {
  const env = input.env ?? process.env
  if (env[EZK.envKey]?.trim()) return true
  const entryOf = (raw: unknown) => {
    const entry = (raw as Record<string, { type?: string; key?: string } | undefined> | undefined)?.[EZK.providerID]
    if (!entry || typeof entry !== "object") return false
    return entry.type === "api" ? Boolean(entry.key) : true
  }
  if (env.OPENCODE_AUTH_CONTENT) {
    try {
      return entryOf(JSON.parse(env.OPENCODE_AUTH_CONTENT))
    } catch {
      return false
    }
  }
  try {
    return entryOf(JSON.parse(fs.readFileSync(path.join(input.dataDir ?? Global.Path.data, "auth.json"), "utf8")))
  } catch {
    return false
  }
}
