// e2e: mock Telegram API <-> bridge <-> mock opencode-like agent <-> mock OpenAI-compatible gateway. No real network/API.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { httpAgentClient } from "../../src/ezk/telegram/agent-client"
import { Allowlist } from "../../src/ezk/telegram/allowlist"
import { Bridge } from "../../src/ezk/telegram/bridge"
import { DEFAULT_CONFIG } from "../../src/ezk/telegram/config"
import { RateLimiter } from "../../src/ezk/telegram/ratelimit"
import { makeRedactor } from "../../src/ezk/telegram/redact"
import { TelegramApi } from "../../src/ezk/telegram/telegram-api"
import { mockAgent, mockGateway, mockTelegram } from "./telegram-mocks"

const TOKEN = "123456789:" + "AAFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE01"
const PW = "test-password"
const OWNER = 1001
const STRANGER = 666
const ctl = new AbortController()
let tg: Awaited<ReturnType<typeof mockTelegram>>
let agent: Awaited<ReturnType<typeof mockAgent>>
let gw: Awaited<ReturnType<typeof mockGateway>>
let bridge: Bridge
let folder: string
let liveAllowlist: Allowlist
let configAllowlist = [OWNER]
const logs: string[] = []
const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now()
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout waiting for condition"); await new Promise((r) => setTimeout(r, 15)) }
}

// Fake clock shared by the limiter and the notice throttle: no refill mid-flood, and the 10 s notice window is crossed by hand.
let clock = 1_000_000

beforeAll(async () => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-tg-ws-")))
  gw = await mockGateway()
  agent = await mockAgent(gw.url, PW)
  tg = await mockTelegram(TOKEN)
  bridge = new Bridge({
    api: new TelegramApi(TOKEN, tg.url),
    agent: httpAgentClient(agent.url, "ezkielyna", PW),
    config: { ...DEFAULT_CONFIG, folders: { proj: folder }, defaultFolder: "proj", rateLimit: { capacity: 30, windowSeconds: 60 } },
    allowlist: (liveAllowlist = new Allowlist([OWNER])),
    limiter: new RateLimiter(30, 60_000, () => clock),
    state: {},
    persist: () => {},
    refreshAllowlist: () => liveAllowlist.replace(configAllowlist),
    redactOutput: makeRedactor(TOKEN, PW),
    log: (m) => logs.push(m),
    typingEveryMs: 50,
    now: () => clock,
  })
  void bridge.poll(ctl.signal)
})
afterAll(async () => {
  ctl.abort()
  bridge.stop()
  await Promise.all([tg.close(), agent.close(), gw.close()])
})

describe("telegram bridge e2e (mocks)", () => {
  test("message -> agent -> gateway -> reply, in the chosen folder", async () => {
    tg.say(OWNER, "hello")
    await until(() => tg.texts(OWNER).some((t) => t === "echo: hello"))
    expect(gw.calls.length).toBe(1)
    expect(agent.created[0]!.dir).toBe(folder)
  })

  test("assistant replies redact secrets before Telegram delivery", async () => {
    const secret = "sk-" + "abcdefghijklmnopqrstuvwxyz123456"
    tg.say(OWNER, `echo ${secret}`)
    await until(() => tg.texts(OWNER).some((t) => t.includes("sk-[redacted]")))
    const reply = tg.texts(OWNER).find((t) => t.includes("sk-[redacted]"))!
    expect(reply).not.toContain(secret)
  })

  test("conversation continues in the same session; /new makes another", async () => {
    tg.say(OWNER, "second")
    await until(() => tg.texts(OWNER).includes("echo: second"))
    expect(agent.sessions.size).toBe(1)
    tg.say(OWNER, "/new")
    await until(() => tg.texts(OWNER).includes("New session started."))
    tg.say(OWNER, "third")
    await until(() => tg.texts(OWNER).includes("echo: third"))
    expect(agent.sessions.size).toBe(2)
  })

  test("non-allowlisted user refused 100%: no agent call, no gateway call", async () => {
    const before = { gw: gw.calls.length, sessions: agent.sessions.size, refused: bridge.stats.refused }
    for (let i = 0; i < 20; i++) tg.say(STRANGER, i % 2 ? "run rm -rf" : "/new")
    tg.say(STRANGER, "/pair 12345678")
    tg.press(STRANGER, "p:abc:y")
    await until(() => bridge.stats.refused >= before.refused + 22)
    expect(gw.calls.length).toBe(before.gw)
    expect(agent.sessions.size).toBe(before.sessions)
    expect(tg.texts(STRANGER).every((t) => t === "Not authorized.")).toBe(true)
    expect(tg.texts(STRANGER).length).toBeLessThanOrEqual(1) // notice is itself rate limited
  })

  test("a config deny revokes a user from the running bridge immediately", async () => {
    const before = bridge.stats.refused
    configAllowlist = [] // models `ezkielyna gateway telegram deny <id>` updating config.json
    tg.say(OWNER, "/status")
    await until(() => bridge.stats.refused > before)
    expect(tg.texts(OWNER).some((t) => t.startsWith("Folder:") && t.includes("Running:"))).toBe(false)
    expect(liveAllowlist.list()).toEqual([])

    configAllowlist = [OWNER]
    tg.say(OWNER, "/status")
    await until(() => tg.texts(OWNER).some((t) => t.startsWith("Folder:") && t.includes("Running:")))
    expect(liveAllowlist.list()).toEqual([OWNER])
  })

  test("group chat and bot senders are ignored, even for the owner", async () => {
    const before = gw.calls.length
    tg.say(OWNER, "hi group", { id: -100123, type: "supergroup" } as any)
    await new Promise((r) => setTimeout(r, 400))
    expect(gw.calls.length).toBe(before)
    expect(tg.texts(-100123)).toEqual([])
  })

  test("permission: Allow button approves, run completes", async () => {
    tg.say(OWNER, "NEEDPERM please")
    await until(() => tg.buttons().length >= 2)
    const allow = tg.buttons().find((b) => b.callback_data.endsWith(":y"))!
    tg.press(OWNER, allow.callback_data)
    await until(() => tg.texts(OWNER).includes("echo: NEEDPERM please"))
    expect(agent.replies.at(-1)!.response).toBe("once")
  })

  test("permission: Deny button rejects", async () => {
    const n = tg.buttons().length
    tg.say(OWNER, "NEEDPERM again")
    await until(() => tg.buttons().length >= n + 2)
    const deny = tg.buttons().slice(n).find((b) => b.callback_data.endsWith(":n"))!
    tg.press(OWNER, deny.callback_data)
    await until(() => tg.texts(OWNER).includes("permission denied"))
    expect(agent.replies.at(-1)!.response).toBe("reject")
  })

  test("long permission requests show every command chunk before approval controls", async () => {
    const before = tg.sent.length
    const beforeButtons = tg.buttons().length
    tg.say(OWNER, "NEEDPERM_LONG")
    await until(() => tg.buttons().length >= beforeButtons + 2)
    const sent = tg.sent.slice(before).filter((item) => item.method === "sendMessage")
    const buttonAt = sent.findIndex((item) => item.body.reply_markup)
    expect(buttonAt).toBeGreaterThan(0)
    const details = sent.slice(0, buttonAt).map((item) => String(item.body.text)).join("")
    expect(details).toContain("Command:")
    expect(details).toContain("final-dangerous-step")
    expect(details).not.toContain("truncated")
    const allow = tg.buttons().at(-2)!
    const beforeReplies = agent.replies.length
    tg.press(OWNER, allow.callback_data)
    await until(() => agent.replies.length > beforeReplies)
    expect(agent.replies.at(-1)?.response).toBe("once")
  })

  test("a stranger cannot press the owner's button", async () => {
    const n = tg.buttons().length
    tg.say(OWNER, "NEEDPERM third")
    await until(() => tg.buttons().length >= n + 2)
    const allow = tg.buttons().slice(n).find((b) => b.callback_data.endsWith(":y"))!
    const replies = agent.replies.length
    tg.press(STRANGER, allow.callback_data, OWNER) // forged chat id
    await new Promise((r) => setTimeout(r, 400))
    expect(agent.replies.length).toBe(replies)
    tg.press(OWNER, allow.callback_data)
    await until(() => agent.replies.length === replies + 1)
    expect(agent.replies.at(-1)!.response).toBe("once")
    await until(() => tg.texts(OWNER).includes("echo: NEEDPERM third"))
  })

  test("request outside the folder is refused automatically, without buttons", async () => {
    const n = tg.buttons().length
    tg.say(OWNER, "ESCAPE now")
    await until(() => tg.texts(OWNER).some((t) => t.startsWith("Refused: path outside the chosen workspace")))
    expect(tg.buttons().length).toBe(n)
    expect(agent.replies.at(-1)!.response).toBe("reject")
    await until(() => tg.texts(OWNER).filter((t) => t === "permission denied").length >= 2)
  })

  test("long result is cut short and offered as a file", async () => {
    tg.say(OWNER, "LONG")
    await until(() => tg.docs.length === 1)
    const msg = tg.texts(OWNER).find((t) => t.includes("truncated"))!
    expect(msg.length).toBeLessThan(3700)
    expect(tg.docs[0]!.name).toBe("result.txt")
  })

  test("rate limit: flood from the owner gets throttled", async () => {
    const before = bridge.stats.rateLimited
    clock += 11_000 // past any earlier "Too many messages" notice window; the bucket stays frozen below
    for (let i = 0; i < 60; i++) tg.say(OWNER, "/status")
    await until(() => bridge.stats.rateLimited > before)
    // the counter moves before the reply is sent, so wait for the reply itself
    await until(() => tg.texts(OWNER).some((t) => t.startsWith("Too many messages")))
    expect(tg.texts(OWNER).some((t) => t.startsWith("Too many messages"))).toBe(true)
  })

  test("the token never appears in logs", () => {
    expect(logs.join("\n")).not.toContain("AAFAKE")
  })
})
