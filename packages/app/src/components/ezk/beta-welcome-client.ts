import type { BetaHealthCheck } from "@opencode-ai/core/ezk/diag/beta-welcome"
import { authTokenFromCredentials } from "@/utils/server"
import type { EzkConnection } from "./client"

export async function fetchBetaHealth(
  conn: EzkConnection,
  directory: string,
  lang: string,
  fetcher: typeof fetch = fetch,
): Promise<BetaHealthCheck[]> {
  const query = new URLSearchParams({ directory, lang })
  const response = await fetcher(`${conn.url.replace(/\/+$/, "")}/ezk/beta/health?${query}`, {
    headers: conn.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: conn.username, password: conn.password })}` }
      : {},
  })
  const body = (await response.json().catch(() => ({}))) as { checks?: BetaHealthCheck[]; error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  if (!Array.isArray(body.checks)) throw new Error("Health checklist is unavailable")
  return body.checks
}
