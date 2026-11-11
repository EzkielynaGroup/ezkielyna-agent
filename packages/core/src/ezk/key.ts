// Ezkielyna Agent v1.1: read the gateway key for background calls (model list, memory reviewer).
// Same sources as the provider: env EZKIELYNA_API_KEY, else auth.json with the OS-keychain sentinel resolved.
import type { SecretStore } from "../ezkielyna-secrets"
import { readLocalKey } from "../ezkielyna-localkey"

export function readGatewayKey(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  secretStore?: Pick<SecretStore, "get">,
): string | undefined {
  return readLocalKey({ dataDir, env, secretStore })
}
