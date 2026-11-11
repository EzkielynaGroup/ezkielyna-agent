import { EZK } from "./ezkielyna-brand"

// Ezkielyna Agent: account status for the sidebar (plan name + remaining quota / balance).
//
// Two sources, tried in order:
//   1. Store endpoint GET {EZK.storeApi}/api/store/agent/me with `Authorization: Bearer <key>` (live; cached server-side for
//      30 s and limited to 20/min per key, so callers poll at most once a minute). Only used while the runtime features
//      probe says `me: true` (server-side kill switch).
//   2. Gateway billing endpoints that exist for every key (OpenAI-compatible, CORS enabled):
//      GET {EZK.baseURL}/dashboard/billing/subscription -> hard_limit_usd, /usage -> total_usage (USD).
// Nothing is sent anywhere but our own two hosts, and only the user's own key is used.

/** Display-only conversion, labelled with an approximation sign in the UI. */
export const IDR_PER_USD = 15000

export type AccountStatus = {
  source: "store" | "gateway"
  kind?: "balance" | "plan"
  label?: string
  /** Plan label, e.g. "Flash 100". */
  plan?: string
  planStatus?: "active" | "capped" | "expired"
  /** Tokens left today on a plan (cap minus used). */
  remainingTokens?: number
  capTokens?: number
  resetsAt?: string
  expiresAt?: string
  /** USD balance of a pay-as-you-go key (or quota left according to the gateway). */
  remainingUsd?: number
  unlimited?: boolean
}

/** Renderer-safe outcome. The credential is accepted only by the sidecar and is never part of this payload. */
export type AccountLookup =
  | { state: "available"; account: AccountStatus }
  | { state: "refused" | "unavailable" }

type Json = Record<string, unknown>
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined)
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const rec = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {})

/** Maps the /me body: balance keys report balance_usd, plan keys report plan{tier,label,cap_tokens,used_today,resets_at,expires_at,status}. */
export function fromStore(body: unknown): AccountStatus | undefined {
  const root = rec(body)
  if (root.ok !== true) return
  const plan = rec(root.plan)
  const label = str(root.account_label)
  if (Object.keys(plan).length) {
    const cap = num(plan.cap_tokens)
    const used = num(plan.used_today)
    const status = str(plan.status)
    return {
      source: "store",
      kind: "plan",
      label,
      plan: str(plan.label) ?? str(plan.tier),
      planStatus: status === "capped" || status === "expired" ? status : "active",
      capTokens: cap,
      remainingTokens: cap !== undefined && used !== undefined ? Math.max(0, cap - used) : undefined,
      resetsAt: str(plan.resets_at),
      expiresAt: str(plan.expires_at),
    }
  }
  const balance = num(root.balance_usd)
  if (balance === undefined && !label) return
  return { source: "store", kind: "balance", label, remainingUsd: balance }
}

const UNLIMITED_USD = 1_000_000

export async function fromGateway(key: string, f: typeof fetch, signal?: AbortSignal): Promise<AccountStatus | undefined> {
  const headers = { Authorization: `Bearer ${key}` }
  const [sub, use] = await Promise.all([
    f(`${EZK.baseURL}/dashboard/billing/subscription`, { headers, signal }).then((r) => (r.ok ? r.json() : undefined)),
    f(`${EZK.baseURL}/dashboard/billing/usage`, { headers, signal }).then((r) => (r.ok ? r.json() : undefined)),
  ])
  const limit = num(rec(sub).hard_limit_usd)
  const used = num(rec(use).total_usage)
  if (limit === undefined || used === undefined) return
  if (limit >= UNLIMITED_USD) return { source: "gateway", unlimited: true }
  return { source: "gateway", remainingUsd: Math.max(0, limit - used) }
}

async function fromGatewayLookup(key: string, f: typeof fetch, signal?: AbortSignal): Promise<AccountLookup> {
  try {
    const headers = { Authorization: `Bearer ${key}` }
    const [sub, use] = await Promise.all([
      f(`${EZK.baseURL}/dashboard/billing/subscription`, { headers, signal }),
      f(`${EZK.baseURL}/dashboard/billing/usage`, { headers, signal }),
    ])
    if ([sub.status, use.status].some((status) => status === 401 || status === 403)) return { state: "refused" }
    if (!sub.ok || !use.ok) return { state: "unavailable" }
    const [subBody, useBody] = await Promise.all([sub.json(), use.json()])
    const limit = num(rec(subBody).hard_limit_usd)
    const used = num(rec(useBody).total_usage)
    if (limit === undefined || used === undefined) return { state: "unavailable" }
    if (limit >= UNLIMITED_USD) return { state: "available", account: { source: "gateway", unlimited: true } }
    return { state: "available", account: { source: "gateway", remainingUsd: Math.max(0, limit - used) } }
  } catch {
    return { state: "unavailable" }
  }
}

/** Account lookup for the sidecar route, preserving an auth refusal without returning or logging the key. */
export async function loadAccountLookup(
  key: string,
  f: typeof fetch = fetch,
  signal?: AbortSignal,
  deviceId?: string,
): Promise<AccountLookup> {
  let storeRefused = false
  try {
    if (await meAvailable(f, signal)) {
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
      if (deviceId) headers["X-Ezk-Agent-Device"] = deviceId
      const res = await f(`${EZK.storeApi}/api/store/agent/me`, { headers, signal })
      if (res.ok) {
        const account = fromStore(await res.json())
        if (account) return { state: "available", account }
      } else if (res.status === 401 || res.status === 403) {
        storeRefused = true
      }
    }
  } catch {}
  if (storeRefused) return { state: "refused" }
  const gateway = await fromGatewayLookup(key, f, signal)
  return gateway
}

let featuresAt = 0
let meEnabled = true

/** Runtime kill-switch probe, cached for 10 minutes; an unreachable probe keeps the last known value. */
async function meAvailable(f: typeof fetch, signal?: AbortSignal) {
  if (Date.now() - featuresAt < 600_000) return meEnabled
  try {
    const res = await f(`${EZK.storeApi}/api/store/agent/features`, { signal })
    if (res.ok) {
      meEnabled = rec(await res.json()).me === true
      featuresAt = Date.now()
    }
  } catch {}
  return meEnabled
}

export function resetAccountCache() {
  featuresAt = 0
  meEnabled = true
}

export async function loadAccountStatus(key: string, f: typeof fetch = fetch, signal?: AbortSignal, deviceId?: string): Promise<AccountStatus | undefined> {
  try {
    if (await meAvailable(f, signal)) {
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
      if (deviceId) headers["X-Ezk-Agent-Device"] = deviceId
      const res = await f(`${EZK.storeApi}/api/store/agent/me`, { headers, signal })
      if (res.ok) {
        const parsed = fromStore(await res.json())
        if (parsed) return parsed
      }
    }
  } catch {}
  return fromGateway(key, f, signal).catch(() => undefined)
}

/** Whole tokens in short form: 98.8M, 1.2k. */
export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(Math.round(value))
}

export function formatIdr(usd: number) {
  return `Rp${Math.round(usd * IDR_PER_USD).toLocaleString("id-ID")}`
}

export function formatUsd(value: number) {
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`
}

export type AccountLang = "id" | "en"

const WORDS = {
  id: { tokensLeft: "token tersisa hari ini", capped: "batas harian tercapai", expired: "paket berakhir", balance: "Saldo", unlimited: "Tanpa batas", resets: "reset", validUntil: "berlaku sampai", account: "Akun" },
  en: { tokensLeft: "tokens left today", capped: "daily limit reached", expired: "plan expired", balance: "Balance", unlimited: "No limit", resets: "resets", validUntil: "valid until", account: "Account" },
} as const

/** One-line summary for footers, e.g. "Flash 100 · 98.8M tokens left today" or "Balance $1.00 (≈ Rp15.000)". */
export function accountLine(a: AccountStatus, lang: AccountLang = "en") {
  const w = WORDS[lang]
  const parts: string[] = []
  if (a.plan) parts.push(a.plan)
  if (a.planStatus === "expired") parts.push(w.expired)
  else if (a.planStatus === "capped") parts.push(w.capped)
  else if (a.remainingTokens !== undefined) parts.push(`${formatTokens(a.remainingTokens)} ${w.tokensLeft}`)
  else if (a.unlimited) parts.push(w.unlimited)
  else if (a.remainingUsd !== undefined) parts.push(`${w.balance} ${formatUsd(a.remainingUsd)} (≈ ${formatIdr(a.remainingUsd)})`)
  return parts.join(" · ")
}

/** Detail lines for `ezkielyna account` and tooltips. */
export function accountDetails(a: AccountStatus, lang: AccountLang = "en", locale?: string) {
  const w = WORDS[lang]
  const lines: string[] = []
  if (a.label) lines.push(`${w.account}: ${a.label}`)
  const line = accountLine(a, lang)
  if (line) lines.push(line)
  if (a.capTokens !== undefined && a.remainingTokens !== undefined) lines.push(`${formatTokens(a.remainingTokens)} / ${formatTokens(a.capTokens)}`)
  if (a.resetsAt) lines.push(`${w.resets}: ${new Date(a.resetsAt).toLocaleString(locale)}`)
  if (a.expiresAt) lines.push(`${w.validUntil}: ${new Date(a.expiresAt).toLocaleDateString(locale)}`)
  return lines
}
