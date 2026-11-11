// U5 desktop: reads for the sidebar status block. Everything comes from existing server routes plus GET /ezk/status.
import type { UsageResponse } from "@opencode-ai/core/ezk/exec/contracts"
import type { StatusResponse } from "@opencode-ai/core/ezk/exec/status-contract"
import type { AccountLookup } from "@opencode-ai/core/ezkielyna-account"
import { authTokenFromCredentials } from "@/utils/server"
import type { EzkConnection } from "./client"

export type AccountResponse = AccountLookup | { state: "missing"; reason?: "keychain-unreadable" }

export function statusClient(
  conn: EzkConnection,
  f: typeof fetch = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch,
) {
  const get = async <T>(path: string): Promise<T> => {
    const res = await f(`${conn.url.replace(/\/+$/, "")}${path}`, {
      headers: conn.password
        ? { Authorization: `Basic ${authTokenFromCredentials({ username: conn.username, password: conn.password })}` }
        : {},
    })
    const json = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
    return json
  }
  const e = encodeURIComponent
  return {
    usage: (sessionID: string) => get<UsageResponse>(`/ezk/usage?sessionID=${e(sessionID)}`),
    account: () => get<AccountResponse>("/ezk/account"),
    status: (directory: string, sessionID?: string, model?: string) =>
      get<StatusResponse>(
        `/ezk/status?directory=${e(directory)}${sessionID ? `&sessionID=${e(sessionID)}` : ""}${model ? `&model=${e(model)}` : ""}`,
      ),
    permission: (directory: string, sessionID?: string) =>
      get<NonNullable<import("./status-model").ChipInput["permission"]>>(
        `/ezk/permission?directory=${e(directory)}${sessionID ? `&sessionID=${e(sessionID)}` : ""}`,
      ),
    trust: (directory: string) => get<{ trusted: boolean }>(`/ezk/trust?directory=${e(directory)}`),
  }
}
