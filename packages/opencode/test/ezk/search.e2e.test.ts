import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
let gw: ReturnType<typeof startMockGateway> | undefined
let srv: Server | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

describe("session search e2e", () => {
  test("lazy index, tool + route find earlier sessions, private sessions are excluded, wipe removes the index", async () => {
    const call = { ok: true as const, tool: { name: "session_search", args: { query: "kumquat marmalade" } } }
    gw = startMockGateway({ models: { [KEY]: ["minimax-m3.1-flash", "deepseek-v4.1-flash"] }, script: { "minimax-m3.1-flash": [{ ok: true, text: "ok" }, { ok: true, text: "ok" }, call, { ok: true, text: "found it" }] } })
    srv = await startServer({ baseURL: gw.baseURL, key: KEY, config: { ezk: { memory: { review: false } } } })
    const searchDb = path.join(srv.dirs.data, "ezkielyna", "ezk", "search.db")

    const a = await newSession(srv)
    await prompt(srv, a.id, "please write a kumquat marmalade recipe", "minimax-m3.1-flash")
    const p = await newSession(srv)
    await srv.api("POST", "/ezk/memory/private", { sessionID: p.id, on: true })
    await prompt(srv, p.id, "private kumquat marmalade secret chat", "minimax-m3.1-flash")
    expect(fs.existsSync(searchDb)).toBe(false) // lazy: nothing built yet

    const r = await srv.api("GET", `/ezk/search?q=kumquat%20marmalade&exclude=${p.id}`)
    expect(fs.existsSync(searchDb)).toBe(true)
    expect(fs.statSync(searchDb).mode & 0o777).toBe(0o600)
    expect(r.builtMs).toBeGreaterThanOrEqual(0)
    expect(r.hits.map((h: any) => h.sessionID)).toEqual([a.id])
    expect(r.hits[0].snippet).toContain("[kumquat]")

    // the agent tool, called from a third session
    const c = await newSession(srv)
    await prompt(srv, c.id, "what did we cook before?", "minimax-m3.1-flash")
    const last = JSON.stringify(gw.requests.at(-1)!.body.messages)
    expect(last).toContain(a.id)
    expect(last).not.toContain(p.id)

    // the tool is in the request, with a small schema
    const tool = gw.requests[0]!.body.tools.find((t: any) => t.function.name === "session_search")
    expect(Math.ceil(JSON.stringify(tool).length / 4)).toBeLessThanOrEqual(150)

    await srv.api("POST", "/ezk/memory/wipe", { confirm: true })
    expect(fs.existsSync(searchDb)).toBe(false)
  }, 120_000)

  test("flag off (-search): tool absent and route returns nothing", async () => {
    gw = startMockGateway({ models: { [KEY]: ["minimax-m3.1-flash"] } })
    srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "-search" } })
    const s = await newSession(srv)
    await prompt(srv, s.id, "hi", "minimax-m3.1-flash")
    expect(JSON.stringify(gw.requests[0]!.body.tools ?? [])).not.toContain("session_search")
    expect((await srv.api("GET", "/ezk/search?q=hi")).hits).toEqual([])
  }, 90_000)
})
