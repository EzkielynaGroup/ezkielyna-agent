import { authTokenFromCredentials } from "@/utils/server"
import type { EzkConnection } from "./client"

export async function fetchBugReport(conn: EzkConnection, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${conn.url.replace(/\/+$/, "")}/ezk/bugreport`, {
    method: "GET",
    headers: conn.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: conn.username, password: conn.password })}` }
      : {},
  })
  const body = (await response.json().catch(() => ({}))) as { enabled?: boolean; report?: string; error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  if (!body.enabled || typeof body.report !== "string") throw new Error("Bug report is turned off or unavailable")
  return body.report
}
