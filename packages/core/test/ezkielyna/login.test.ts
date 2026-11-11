import { afterEach, describe, expect, test } from "bun:test"
import { DEVICE_GRANT, fetchFeatures, pollDeviceLogin, startDeviceLogin, type DeviceStart } from "../../src/ezkielyna-login"

// Mock of the store's device-login endpoints (bot 0076): HTTP 400 for pending/slow_down, 200 exactly once.
type Reply = { status: number; body: unknown; headers?: Record<string, string> }
function mockStore(script: { code?: Reply; tokens: Reply[]; features?: Reply }) {
  const seen: { path: string; body: Record<string, unknown> }[] = []
  const queue = [...script.tokens]
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
      seen.push({ path: url.pathname, body })
      const send = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers })
      if (url.pathname === "/api/store/agent/features") return send(script.features ?? { status: 200, body: { device_login: true, me: true } })
      if (url.pathname === "/api/store/agent/device/code")
        return send(script.code ?? { status: 200, body: { device_code: "dc-1", user_code: "ABCD-EFGH", verification_uri: "https://ezkielyna.store/agent/activate", verification_uri_complete: "https://ezkielyna.store/agent/activate?c=ABCD-EFGH", expires_in: 600, interval: 5 } })
      if (url.pathname === "/api/store/agent/device/token") return send(queue.shift() ?? { status: 400, body: { error: "expired_token" } })
      return new Response("nope", { status: 404 })
    },
  })
  return { base: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

const start: DeviceStart = { deviceCode: "dc-1", userCode: "ABCD-EFGH", verificationUri: "https://ezkielyna.store/agent/activate", expiresIn: 600, interval: 5 }
const clock = () => {
  const sleeps: number[] = []
  let t = 0
  return { sleeps, deps: { sleep: async (ms: number) => void (sleeps.push(ms / 1000), (t += ms)), now: () => t } }
}

let stop: (() => void) | undefined
afterEach(() => stop?.())

describe("device login against a mock store", () => {
  test("pending -> slow_down -> success: honours returned intervals, returns the key once with metadata", async () => {
    const m = mockStore({
      tokens: [
        { status: 400, body: { error: "authorization_pending", interval: 5 } },
        { status: 400, body: { error: "slow_down", interval: 10 } },
        { status: 400, body: { error: "authorization_pending", error_description: "gateway hiccup" } },
        { status: 200, body: { api_key: "sk-" + "mock-key-for-test", access_token: "sk-" + "mock-key-for-test", key_kind: "plan", plan_tier: "flash100", account_label: "ab***", device_id: 2, key_id: "plan-flash" } },
      ],
    })
    stop = m.stop
    const c = clock()
    const begun = await startDeviceLogin({ deviceName: "Mac test", platform: "darwin", base: m.base })
    expect(begun).toMatchObject({ deviceCode: "dc-1", userCode: "ABCD-EFGH", interval: 5 })
    expect(m.seen[0].body).toMatchObject({ client_id: "ezkielyna-agent", device_name: "Mac test", platform: "darwin" })
    const result = await pollDeviceLogin(begun, { base: m.base, ...c.deps })
    expect(result).toEqual({ type: "success", apiKey: "sk-" + "mock-key-for-test", metadata: { key_kind: "plan", plan_tier: "flash100", account_label: "ab***", device_id: "2", key_id: "plan-flash", via: "account-login" } })
    expect(c.sleeps).toEqual([5, 5, 10, 10]) // slow_down raised the interval and it stays raised
    const polls = m.seen.filter((s) => s.path.endsWith("/device/token"))
    expect(polls).toHaveLength(4)
    expect(polls[0].body).toMatchObject({ grant_type: DEVICE_GRANT, device_code: "dc-1" })
  })

  test("access_denied and expired_token end the flow", async () => {
    for (const error of ["access_denied", "expired_token", "invalid_grant"] as const) {
      const m = mockStore({ tokens: [{ status: 400, body: { error: "authorization_pending" } }, { status: 400, body: { error } }] })
      const result = await pollDeviceLogin(start, { base: m.base, ...clock().deps })
      m.stop()
      expect(result).toEqual({ type: "failed", reason: error })
    }
  })

  test("a deadline passing without approval is a timeout", async () => {
    const m = mockStore({ tokens: Array.from({ length: 200 }, () => ({ status: 400, body: { error: "authorization_pending" } })) })
    stop = m.stop
    const result = await pollDeviceLogin({ ...start, expiresIn: 30 }, { base: m.base, ...clock().deps })
    expect(result).toEqual({ type: "failed", reason: "timeout" })
  })

  test("429 with Retry-After backs off; a network error is retried", async () => {
    const m = mockStore({ tokens: [{ status: 429, body: {}, headers: { "retry-after": "20" } }, { status: 200, body: { api_key: "sk-ok-ok-ok-ok" } }] })
    stop = m.stop
    const c = clock()
    const result = await pollDeviceLogin(start, { base: m.base, ...c.deps })
    expect(result.type).toBe("success")
    expect(c.sleeps).toEqual([5, 20])
    let calls = 0
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      if (calls++ === 0) throw new Error("network down")
      return fetch(...args)
    }) as typeof fetch
    const m2 = mockStore({ tokens: [{ status: 200, body: { api_key: "sk-second-key-ok" } }] })
    const r2 = await pollDeviceLogin(start, { base: m2.base, fetch: flaky, ...clock().deps })
    m2.stop()
    expect(r2.type).toBe("success")
  })

  test("a 200 without an sk- key is not accepted", async () => {
    const m = mockStore({ tokens: [{ status: 200, body: { api_key: "not-a-key" } }, { status: 400, body: { error: "access_denied" } }] })
    stop = m.stop
    expect(await pollDeviceLogin(start, { base: m.base, ...clock().deps })).toEqual({ type: "failed", reason: "access_denied" })
  })

  test("start errors: 429, 503, malformed reply, http verification URL", async () => {
    for (const [reply, text] of [
      [{ status: 429, body: {} }, /Terlalu banyak/],
      [{ status: 503, body: {} }, /tidak tersedia/],
      [{ status: 200, body: { nope: 1 } }, /Tidak bisa memulai/],
      [{ status: 200, body: { device_code: "d", user_code: "u", verification_uri: "http://evil.example/x" } }, /https/],
    ] as [Reply, RegExp][]) {
      const m = mockStore({ code: reply, tokens: [] })
      await expect(startDeviceLogin({ deviceName: "x", platform: "linux", base: m.base })).rejects.toThrow(text)
      m.stop()
    }
  })

  test("features probe: flags on, kill switch off, and unreachable = off", async () => {
    const on = mockStore({ tokens: [] })
    expect(await fetchFeatures({ base: on.base })).toEqual({ deviceLogin: true, me: true })
    on.stop()
    const off = mockStore({ tokens: [], features: { status: 200, body: { device_login: false, me: false } } })
    expect(await fetchFeatures({ base: off.base })).toEqual({ deviceLogin: false, me: false })
    off.stop()
    expect(await fetchFeatures({ base: "http://127.0.0.1:1" })).toEqual({ deviceLogin: false, me: false })
  })
})
