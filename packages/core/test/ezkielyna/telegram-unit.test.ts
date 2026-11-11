import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Allowlist, Pairing } from "../../src/ezk/telegram/allowlist"
import { RateLimiter } from "../../src/ezk/telegram/ratelimit"
import { decide, describeAsk, splitPermissionText } from "../../src/ezk/telegram/permission"
import { findEscape, isInside } from "../../src/ezk/telegram/pathguard"
import { makeRedactor } from "../../src/ezk/telegram/redact"
import { TelegramApi } from "../../src/ezk/telegram/telegram-api"
import { loadToken, saveToken, validToken } from "../../src/ezk/telegram/config"
import { assertTelegramProfile } from "../../src/ezk/telegram/run"
import type { SecretStore } from "../../src/ezkielyna-secrets"

const FAKE = "123456789:" + "AAFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE01"
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ezk-tg-"))
const memStore = (): SecretStore & { m: Map<string, string> } => {
  const m = new Map<string, string>()
  return { m, backend: "keychain", get: (a) => m.get(a), set: (a, s) => (m.set(a, s), true), delete: (a) => void m.delete(a) }
}

describe("allowlist", () => {
  test("only registered numeric ids pass", () => {
    const a = new Allowlist([42, -1, 0, 1.5, NaN])
    expect(a.has(42)).toBe(true)
    for (const bad of [41, "42", undefined, null, -1, 0, NaN, {}]) expect(a.has(bad)).toBe(false)
    a.remove(42)
    expect(a.has(42)).toBe(false)
  })
  test("pairing code is single use, expires and burns attempts", () => {
    let t = 0
    const p = new Pairing(1000, 3, () => t)
    const code = p.issue()
    expect(p.redeem("00000000" === code ? "11111111" : "00000000")).toBe(false)
    expect(p.redeem(code)).toBe(true)
    expect(p.redeem(code)).toBe(false)
    const c2 = p.issue()
    t = 5000
    expect(p.redeem(c2)).toBe(false)
    const c3 = p.issue()
    for (let i = 0; i < 3; i++) p.redeem("x")
    p.redeem("x")
    expect(p.redeem(c3)).toBe(false) // invalidated after too many attempts
  })
})

describe("rate limit", () => {
  test("burst then refuse, refill over time, per user", () => {
    let t = 0
    const r = new RateLimiter(3, 3000, () => t)
    expect([r.take(1), r.take(1), r.take(1)]).toEqual([0, 0, 0])
    expect(r.take(1)).toBeGreaterThan(0)
    expect(r.take(2)).toBe(0) // other user unaffected
    t = 1000
    expect(r.take(1)).toBe(0)
    expect(r.take(1)).toBeGreaterThan(0)
  })
})

describe("path guard and permission policy", () => {
  const root = fs.realpathSync(tmp())
  fs.mkdirSync(path.join(root, "src"))
  const outside = fs.realpathSync(tmp())
  fs.symlinkSync(outside, path.join(root, "link"))
  test("isInside handles .., absolute, ~, symlinks, new files", () => {
    expect(isInside(root, "src/a.ts")).toBe(true)
    expect(isInside(root, path.join(root, "new/dir/file"))).toBe(true)
    expect(isInside(root, "../x")).toBe(false)
    expect(isInside(root, "/etc/passwd")).toBe(false)
    expect(isInside(root, "~/.ssh/id_rsa")).toBe(false)
    expect(isInside(root, "link/secret")).toBe(false)
    expect(isInside(root, path.dirname(root) + "/" + path.basename(root) + "-evil/x")).toBe(false)
  })
  test("findEscape in shell commands", () => {
    expect(findEscape(root, "cat /etc/passwd")).toBe("/etc/passwd")
    expect(findEscape(root, "cp a.txt ../b.txt")).toBe("../b.txt")
    expect(findEscape(root, "echo hi > ~/x")).toBe("~/x")
    expect(findEscape(root, "ls -la ./src && git status")).toBeUndefined()
  })
  test("decide: reject outside / external_directory, ask otherwise", () => {
    const ask = (permission: string, patterns: string[], metadata = {}) => ({ id: "p", sessionID: "s", permission, patterns, metadata })
    expect(decide(root, ask("external_directory", ["/tmp/*"]).permission === "x" ? ask("x", []) : ask("external_directory", ["/tmp/*"])).action).toBe("reject")
    expect(decide(root, ask("read", ["/etc/hosts"])).action).toBe("reject")
    expect(decide(root, ask("edit", ["src/a.ts"], { filepath: path.join(root, "src/a.ts") })).action).toBe("ask")
    expect(decide(root, ask("edit", ["x"], { filepath: "/etc/hosts" })).action).toBe("reject")
    expect(decide(root, ask("bash", ["rm -rf ../.."])).action).toBe("reject")
    expect(decide(root, ask("bash", ["npm test"])).action).toBe("ask")
  })
  test("permission details preserve long commands across Telegram-sized messages", () => {
    const command = `echo safe; ${"echo ok; ".repeat(90)}run-dangerous-step`
    const details = describeAsk({ id: "p", sessionID: "s", permission: "bash", patterns: ["bash"], metadata: { command } })
    const chunks = splitPermissionText(details, 300)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join("")).toBe(details)
    expect(chunks.join("")).toContain(command)
    expect(chunks.at(-1)).toContain("run-dangerous-step")
  })
})

describe("token handling", () => {
  test("validToken", () => {
    expect(validToken(FAKE)).toBe(true)
    expect(validToken("nope")).toBe(false)
  })
  test("token goes to the keychain, not to disk", () => {
    const dir = tmp()
    const store = memStore()
    expect(saveToken(FAKE, dir, store)).toBe("keychain")
    expect(fs.readdirSync(dir)).toEqual([])
    expect(loadToken(dir, store, {})).toBe(FAKE)
  })
  test("file fallback is 0600; env wins", () => {
    const dir = tmp()
    const none: SecretStore = { backend: "none", get: () => undefined, set: () => false, delete: () => {} }
    expect(saveToken(FAKE, dir, none)).toBe("file")
    expect(fs.statSync(path.join(dir, "token")).mode & 0o777).toBe(0o600)
    expect(loadToken(dir, none, {})).toBe(FAKE)
    expect(loadToken(dir, none, { EZK_TELEGRAM_BOT_TOKEN: "envtoken:xxxxxxxxxxxxxxxxxxxxxxxxx" })).toContain("envtoken")
  })
  test("redactor strips the token and bot URLs", () => {
    const r = makeRedactor(FAKE)
    expect(r(`GET https://api.telegram.org/bot${FAKE}/getUpdates failed`)).not.toContain("AAFAKE")
    expect(r(`other 987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`)).toContain("[redacted-bot-token]")
  })
  test("API errors never contain the token", async () => {
    const api = new TelegramApi(FAKE, "http://127.0.0.1:1")
    const err = await api.sendMessage(1, "x").catch((e: Error) => e)
    expect(String((err as Error).message)).not.toContain("AAFAKE")
    const failing = new TelegramApi(FAKE, "https://x", (async (url: string) => { throw new Error(`boom ${url}`) }) as any)
    const e2 = await failing.getUpdates(0, 0).catch((e: Error) => e)
    expect(String((e2 as Error).message)).not.toContain("AAFAKE")
  })
})

describe("profile isolation", () => {
  test("existing Telegram servers must report the isolated profile and memory directory", async () => {
    const okFetch = (async () => new Response(JSON.stringify({ profile: "telegram", dir: "/tmp/telegram-memory" }), { status: 200 })) as unknown as typeof fetch
    await expect(assertTelegramProfile("http://localhost:3000", "user", "pw", "/tmp/telegram-memory", okFetch)).resolves.toBeUndefined()

    const desktopFetch = (async () => new Response(JSON.stringify({ profile: "default", dir: "/tmp/memory" }), { status: 200 })) as unknown as typeof fetch
    await expect(assertTelegramProfile("http://localhost:3000", "user", "pw", "/tmp/telegram-memory", desktopFetch)).rejects.toThrow("not using the isolated Telegram profile")
  })
})
