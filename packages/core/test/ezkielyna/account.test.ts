import { describe, expect, test } from "bun:test"
import { beforeEach } from "bun:test"
import { formatIdr, formatTokens, formatUsd, fromGateway, fromStore, loadAccountLookup, loadAccountStatus, resetAccountCache } from "../../src/ezkielyna-account"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const router = (routes: Record<string, () => Response>) =>
  (async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k))
    return key ? routes[key]() : new Response("{}", { status: 404 })
  }) as unknown as typeof fetch

describe("account status adapter", () => {
  beforeEach(resetAccountCache)

  test("/me plan key: label, remaining = cap - used, reset and expiry, status", () => {
    const plan = { tier: "flash100", label: "Flash 100", cap_tokens: 100_000_000, used_today: 1_234, resets_at: "2026-10-22T00:00:00+07:00", expires_at: "2026-11-20T00:00:00+07:00", status: "active" }
    expect(fromStore({ ok: true, account_label: "ab***@x.com", kind: "plan", plan, balance_usd: null })).toEqual({
      source: "store",
      kind: "plan",
      label: "ab***@x.com",
      plan: "Flash 100",
      planStatus: "active",
      capTokens: 100_000_000,
      remainingTokens: 99_998_766,
      resetsAt: plan.resets_at,
      expiresAt: plan.expires_at,
    })
    expect(fromStore({ ok: true, kind: "plan", plan: { ...plan, used_today: 200_000_000, status: "capped" } })?.remainingTokens).toBe(0)
    expect(fromStore({ ok: true, kind: "plan", plan: { ...plan, status: "expired" } })?.planStatus).toBe("expired")
  })

  test("/me balance key and bad bodies", () => {
    expect(fromStore({ ok: true, account_label: "k", kind: "balance", plan: null, balance_usd: 1 })).toMatchObject({ kind: "balance", remainingUsd: 1 })
    expect(fromStore({ ok: false, error: "invalid_key" })).toBeUndefined()
    expect(fromStore({ nothing: "useful" })).toBeUndefined()
  })

  test("gateway fallback: remaining = limit - usage; huge limit = no limit", async () => {
    const f = router({
      "/dashboard/billing/subscription": () => json({ hard_limit_usd: 0.4 }),
      "/dashboard/billing/usage": () => json({ total_usage: 0.1896 }),
    })
    expect((await fromGateway("sk-test-test-test", f))?.remainingUsd).toBeCloseTo(0.2104, 4)
    const unlimited = router({ "/subscription": () => json({ hard_limit_usd: 100000000 }), "/usage": () => json({ total_usage: 1 }) })
    expect(await fromGateway("sk-test-test-test", unlimited)).toEqual({ source: "gateway", unlimited: true })
  })

  test("/me first when the features probe allows it; the key is sent only as a bearer header", async () => {
    let auth = ""
    const me = router({
      "/api/store/agent/features": () => json({ device_login: true, me: true }),
      "/api/store/agent/me": () => json({ ok: true, kind: "balance", account_label: "x", balance_usd: 2.5 }),
    })
    const spy = ((url: string, init?: RequestInit) => {
      if (String(url).includes("/me")) auth = String((init?.headers as Record<string, string>).Authorization)
      return me(url as never, init)
    }) as unknown as typeof fetch
    expect(await loadAccountStatus("sk-test-test-test", spy)).toMatchObject({ source: "store", remainingUsd: 2.5 })
    expect(auth).toBe("Bearer sk-test-test-test")
  })

  test("kill switch (me:false) or a store error falls back to the gateway", async () => {
    const off = router({
      "/api/store/agent/features": () => json({ device_login: false, me: false }),
      "/api/store/agent/me": () => json({ ok: true, kind: "balance", balance_usd: 99 }),
      "/dashboard/billing/subscription": () => json({ hard_limit_usd: 1 }),
      "/dashboard/billing/usage": () => json({ total_usage: 0.25 }),
    })
    expect(await loadAccountStatus("sk-test-test-test", off)).toEqual({ source: "gateway", remainingUsd: 0.75 })
    resetAccountCache()
    const bad = router({
      "/api/store/agent/features": () => json({ me: true }),
      "/api/store/agent/me": () => json({ ok: false, error: "invalid_key" }, 401),
      "/dashboard/billing/subscription": () => json({ hard_limit_usd: 1 }),
      "/dashboard/billing/usage": () => json({ total_usage: 0.5 }),
    })
    expect(await loadAccountStatus("sk-test-test-test", bad)).toEqual({ source: "gateway", remainingUsd: 0.5 })
  })

  test("nothing reachable gives undefined, never throws", async () => {
    const dead = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await loadAccountStatus("sk-test-test-test", dead)).toBeUndefined()
  })

  test("sidecar outcome distinguishes a rejected key and never returns it", async () => {
    const bad = router({
      "/api/store/agent/features": () => json({ me: true }),
      "/api/store/agent/me": () => json({ error: "invalid_key" }, 401),
      "/dashboard/billing/subscription": () => json({ error: "invalid_key" }, 401),
      "/dashboard/billing/usage": () => json({ error: "invalid_key" }, 401),
    })
    const result = await loadAccountLookup("sk-" + "test-refused-123", bad)
    expect(result).toEqual({ state: "refused" })
    expect(JSON.stringify(result)).not.toContain("sk-" + "test-refused-123")
  })

  test("sidecar lookup stops on store 401 so the UI can show a refused-key state", async () => {
    resetAccountCache()
    let gatewayCalls = 0
    const f = router({
      "/api/store/agent/features": () => json({ me: true }),
      "/api/store/agent/me": () => json({ error: "invalid_key" }, 401),
      "/dashboard/billing/subscription": () => { gatewayCalls++; return json({ hard_limit_usd: 1 }) },
      "/dashboard/billing/usage": () => { gatewayCalls++; return json({ total_usage: 0.25 }) },
    })
    expect(await loadAccountLookup("sk-" + "test-refused-123", f)).toEqual({ state: "refused" })
    expect(gatewayCalls).toBe(0)
  })

  test("money formatting", () => {
    expect(formatUsd(0.2104)).toBe("$0.21")
    expect(formatUsd(250)).toBe("$250")
    expect(formatIdr(1)).toMatch(/^Rp15[.,]000$/)
    expect(formatTokens(99_998_766)).toBe("100M")
    expect(formatTokens(1_500)).toBe("1.5k")
  })
})
