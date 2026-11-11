// Ezkielyna Agent: "Masuk dengan akun Ezkielyna" device login client (OAuth device grant, RFC 8628 shape).
// Server side: store bot 0076 / web 0df6f20 (POST /api/store/agent/device/code, /device/token, GET /features).
// Pure protocol code with injectable fetch/sleep so the whole flow is unit-tested against a mock server.
import { EZK } from "./ezkielyna-brand"

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
export const CLIENT_ID = "ezkielyna-agent"
const MAX_INTERVAL = 60

export type DeviceStart = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

export type LoginResult =
  | { type: "success"; apiKey: string; metadata: Record<string, string> }
  | { type: "failed"; reason: "access_denied" | "expired_token" | "invalid_grant" | "invalid_request" | "timeout" | "unavailable" }

type FetchFn = typeof fetch
type Deps = { base?: string; fetch?: FetchFn; sleep?: (ms: number) => Promise<void>; now?: () => number }

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const clamp = (seconds: number, min = 1) => Math.min(MAX_INTERVAL, Math.max(min, seconds))

async function post(base: string, endpoint: string, body: unknown, f: FetchFn) {
  const res = await f(`${base}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "ezkielyna-agent" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  })
  // The server answers pending/slow_down with HTTP 400 and a JSON body, so always read the body before judging the status.
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json, retryAfter: Number(res.headers.get("retry-after")) || undefined }
}

/** GET /api/store/agent/features: both flags are false when the server-side kill switch is on. */
export async function fetchFeatures(deps: Deps = {}): Promise<{ deviceLogin: boolean; me: boolean }> {
  try {
    const res = await (deps.fetch ?? fetch)(`${deps.base ?? EZK.storeApi}/api/store/agent/features`, { signal: AbortSignal.timeout(4000), redirect: "error" })
    if (!res.ok) return { deviceLogin: false, me: false }
    const body = (await res.json()) as { device_login?: unknown; me?: unknown }
    return { deviceLogin: body.device_login === true, me: body.me === true }
  } catch {
    return { deviceLogin: false, me: false }
  }
}

export async function startDeviceLogin(input: { deviceName: string; platform: string } & Deps): Promise<DeviceStart> {
  const base = input.base ?? EZK.storeApi
  const { status, json } = await post(base, "/api/store/agent/device/code", { client_id: CLIENT_ID, device_name: input.deviceName, platform: input.platform }, input.fetch ?? fetch)
  if (status === 429) throw new Error("Terlalu banyak percobaan masuk. Coba lagi beberapa menit lagi. / Too many sign-in attempts. Try again in a few minutes.")
  if (status !== 200 || typeof json.device_code !== "string" || typeof json.user_code !== "string") {
    throw new Error(status === 503 ? "Masuk dengan akun sedang tidak tersedia. / Account sign-in is temporarily unavailable." : "Tidak bisa memulai masuk dengan akun. / Could not start account sign-in.")
  }
  const uri = String(json.verification_uri ?? `${base}/agent/activate`)
  const complete = typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : undefined
  for (const u of [uri, complete]) if (u && new URL(u).protocol !== "https:") throw new Error("verification URL must be https")
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: uri,
    verificationUriComplete: complete,
    expiresIn: Number(json.expires_in) > 0 ? Number(json.expires_in) : 600,
    interval: clamp(Number(json.interval) || 5),
  }
}

export async function pollDeviceLogin(start: DeviceStart, deps: Deps = {}): Promise<LoginResult> {
  const base = deps.base ?? EZK.storeApi
  const f = deps.fetch ?? fetch
  const sleep = deps.sleep ?? sleepReal
  const now = deps.now ?? Date.now
  const deadline = now() + start.expiresIn * 1000
  let interval = start.interval
  while (now() < deadline) {
    await sleep(interval * 1000)
    let reply
    try {
      reply = await post(base, "/api/store/agent/device/token", { client_id: CLIENT_ID, grant_type: DEVICE_GRANT, device_code: start.deviceCode }, f)
    } catch {
      interval = clamp(interval + 2) // network blip: keep trying until the code expires
      continue
    }
    const { status, json, retryAfter } = reply
    if (status === 200 && typeof json.api_key === "string" && json.api_key.startsWith("sk-")) {
      const metadata: Record<string, string> = {}
      for (const key of ["device_id", "key_kind", "account_label", "plan_tier", "group", "key_id"]) if (json[key] !== undefined && json[key] !== null) metadata[key] = String(json[key])
      metadata.via = "account-login"
      return { type: "success", apiKey: json.api_key, metadata }
    }
    const error = typeof json.error === "string" ? json.error : status === 429 ? "slow_down" : "unavailable"
    if (typeof json.interval === "number") interval = clamp(json.interval)
    switch (error) {
      case "authorization_pending":
        break
      case "slow_down":
        interval = clamp(Math.max(retryAfter ?? 0, typeof json.interval === "number" ? json.interval : interval + 5))
        break
      case "access_denied":
      case "expired_token":
      case "invalid_grant":
      case "invalid_request":
        return { type: "failed", reason: error }
      default:
        // temporarily_unavailable and unknown transient failures: keep polling
        interval = clamp(interval + 2)
    }
  }
  return { type: "failed", reason: "timeout" }
}
