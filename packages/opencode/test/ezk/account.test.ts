import { expect, test } from "bun:test"
import { createAccountLookupService } from "../../src/ezk/account"

test("account lookup caches for one minute and returns no credential material", async () => {
  let calls = 0
  let now = 100_000
  const key = "sk-" + "test-account-cache"
  const service = createAccountLookupService({
    key: () => key,
    now: () => now,
    fetch: (async (url: string) => {
      calls++
      if (url.includes("features")) return new Response(JSON.stringify({ me: true }))
      if (url.includes("/me")) return new Response(JSON.stringify({ ok: true, balance_usd: 1.25 }))
      throw new Error(`unexpected mocked request ${url}`)
    }) as unknown as typeof fetch,
  })

  const first = await service()
  const second = await service()
  expect(first).toEqual({ state: "available", account: { source: "store", kind: "balance", remainingUsd: 1.25 } })
  expect(second).toEqual(first)
  expect(calls).toBe(2)
  expect(JSON.stringify(first)).not.toContain(key)

  now += 60_000
  await service()
  expect(calls).toBe(3) // The feature probe is still cached; only /me refreshes.
})

test("a key that is saved in the keychain but unreadable is reported as missing with a reason", async () => {
  let calls = 0
  const service = createAccountLookupService({
    key: () => undefined,
    missingReason: () => "keychain-unreadable",
    fetch: (async () => {
      calls++
      return new Response("{}")
    }) as unknown as typeof fetch,
  })
  expect(await service()).toEqual({ state: "missing", reason: "keychain-unreadable" })
  expect(calls).toBe(0)
})

test("missing key makes no outbound request", async () => {
  let calls = 0
  const service = createAccountLookupService({
    key: () => undefined,
    fetch: (async () => {
      calls++
      return new Response("{}")
    }) as unknown as typeof fetch,
  })
  expect(await service()).toEqual({ state: "missing" })
  expect(calls).toBe(0)
})

test("account lookup enforces the shared per-key request limit during concurrent refreshes", async () => {
  const key = "sk-" + "test-account-limit"
  let calls = 0
  const fetch = (async (url: URL | RequestInfo) => {
    calls++
    return String(url).includes("/features")
      ? new Response(JSON.stringify({ me: true }))
      : new Response(JSON.stringify({ ok: true, balance_usd: 2 }))
  }) as typeof globalThis.fetch

  const prime = createAccountLookupService({ key: () => key, fetch })
  expect(await prime()).toMatchObject({ state: "available" })
  calls = 0

  const service = createAccountLookupService({ key: () => key, fetch })
  await Promise.all(Array.from({ length: 25 }, () => service()))
  expect(calls).toBe(20)
})
