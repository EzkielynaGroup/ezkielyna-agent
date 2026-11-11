// Code search (T6) and repo map (T7) through the real server against the mock gateway: lazy index, tool output format,
// Explore permission, repo-map reminder only on heavy turns in big git repos, and untouched prompt bytes when off.
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
const MODEL = "minimax-m3.1-flash"
let gw: ReturnType<typeof startMockGateway> | undefined
let srv: Server | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

// A git project with `extra` filler modules (the repo map needs more than 200 files).
function seedProject(project: string, extra = 0) {
  const files: Record<string, string> = {
    "src/auth/session-store.ts": `/** Persist login sessions. */\nexport class SessionStore {\n  /** Remove expired sessions. */\n  purgeExpired(now: number): number { return now }\n}\n`,
    "src/invoice/render.ts": `import { formatInvoiceLine } from "./format"\nexport function renderInvoice(lines: string[]) { return lines.map(formatInvoiceLine) }\n`,
    "src/invoice/format.ts": `export function formatInvoiceLine(line: string): string { return line.trim() }\n`,
    "src/app.ts": `import { SessionStore } from "./auth/session-store"\nexport function startApp() { return new SessionStore().purgeExpired(Date.now()) }\n`,
  }
  for (let i = 0; i < extra; i++) files[`src/filler/mod${i}.ts`] = `export function filler${i}(x: number) { return startApp() + x }\n`
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true })
    fs.writeFileSync(path.join(project, rel), text)
  }
  execFileSync("git", ["init", "-q"], { cwd: project })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: project })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: project })
}

const codeintelDir = (s: Server) => path.join(s.dirs.data, "ezkielyna", "ezk", "codeintel")
const HEAVY = "refactor the invoice rendering in src/invoice/render.ts across the whole codebase"

// The first heavy turn starts the index build and waits for it only briefly; the build finishes in the background and
// a later heavy turn gets the map. Returns the session and request body of the first turn that carried a map.
async function heavyTurnWithMap(s: Server, g: ReturnType<typeof startMockGateway>) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const session = await newSession(s)
    await prompt(s, session.id, HEAVY, MODEL)
    const body = g.requests.at(-1)!.body
    if (JSON.stringify(body.messages).includes("Repository map")) return { session, body }
    await Bun.sleep(1000)
  }
  throw new Error("no repo map after 8 heavy turns")
}

describe("code_search e2e", () => {
  test("lazy per-project index, `path:line  kind  name  signature` hits, small schema, Explore may call it", async () => {
    const call = { ok: true as const, tool: { name: "code_search", args: { query: "purgeExpired" } } }
    gw = startMockGateway({ models: { [KEY]: [MODEL] }, script: { [MODEL]: [call, { ok: true, text: "found" }] } })
    srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+codesearch" }, seed: (d) => seedProject(d.project) })
    expect(fs.existsSync(codeintelDir(srv))).toBe(false)

    const s = await newSession(srv)
    await prompt(srv, s.id, "where are expired sessions purged?", MODEL)
    const dbs = fs.readdirSync(codeintelDir(srv)).filter((f) => f.endsWith(".db"))
    expect(dbs).toHaveLength(1)
    expect(fs.statSync(path.join(codeintelDir(srv), dbs[0]!)).mode & 0o777).toBe(0o600)
    const followUp = JSON.stringify(gw.requests[1]!.body.messages)
    expect(followUp).toContain("src/auth/session-store.ts:4  method  purgeExpired  purgeExpired(now: number): number")

    const tool = gw.requests[0]!.body.tools.find((t: any) => t.function.name === "code_search")
    expect(Math.ceil(JSON.stringify(tool).length / 4)).toBeLessThanOrEqual(150)

    const agents = await srv.api<any[]>("GET", "/agent")
    const explore = agents.find((a) => a.name === "explore")
    const rule = explore.permission.findLast((r: any) => r.permission === "code_search" || r.permission === "*")
    expect(rule).toMatchObject({ permission: "code_search", action: "allow" })
    const anything = explore.permission.findLast((r: any) => r.permission === "edit" || r.permission === "*")
    expect(anything.action).not.toBe("allow") // still read-only
  }, 120_000)

  test("flag off (default): no tool, no index file, Explore unchanged", async () => {
    gw = startMockGateway({ models: { [KEY]: [MODEL] } })
    srv = await startServer({ baseURL: gw.baseURL, key: KEY, seed: (d) => seedProject(d.project) })
    const s = await newSession(srv)
    await prompt(srv, s.id, "hi", MODEL)
    expect(JSON.stringify(gw.requests[0]!.body.tools ?? [])).not.toContain("code_search")
    expect(fs.existsSync(codeintelDir(srv))).toBe(false)
    const explore = (await srv.api<any[]>("GET", "/agent")).find((a) => a.name === "explore")
    expect(JSON.stringify(explore.permission)).not.toContain("code_search")
  }, 90_000)
})

describe("repo map e2e", () => {
  const userTexts = (body: any) => JSON.stringify(body.messages.filter((m: any) => m.role === "user"))

  test("heavy turn in a >200-file repo gets one map reminder; light turns and system prompt are untouched", async () => {
    gw = startMockGateway({ models: { [KEY]: [MODEL] } })
    srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+repomap" }, seed: (d) => seedProject(d.project, 210) })

    const light = await newSession(srv)
    await prompt(srv, light.id, "what does 2+2 make?", MODEL)
    expect(userTexts(gw.requests.at(-1)!.body)).not.toContain("Repository map")

    const { session: heavy, body: first } = await heavyTurnWithMap(srv, gw)
    const users = userTexts(first)
    expect(users).toContain("Repository map")
    expect(users).toContain("src/invoice/format.ts:")
    expect(users).toContain("formatInvoiceLine(line: string): string")
    expect(JSON.stringify(first.messages.filter((m: any) => m.role === "system"))).not.toContain("Repository map")
    // ~1k tokens
    const map = /Repository map[\s\S]*?<\/system-reminder>/.exec(users.replace(/\\n/g, "\n"))![0]
    expect(Math.ceil(map.length / 4)).toBeLessThanOrEqual(1024 * 1.1)

    // Second heavy turn, same commit: the first map stays in history, no second one.
    await prompt(srv, heavy.id, "now migrate the whole project to the new invoice format", MODEL)
    expect(userTexts(gw.requests.at(-1)!.body).match(/Repository map/g)).toHaveLength(1)
  }, 120_000)

  test("small repo (<= 200 files): no map even on heavy turns", async () => {
    gw = startMockGateway({ models: { [KEY]: [MODEL] } })
    srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+repomap" }, seed: (d) => seedProject(d.project, 10) })
    for (let i = 0; i < 3; i++) {
      const s = await newSession(srv)
      await prompt(srv, s.id, HEAVY, MODEL)
      expect(userTexts(gw.requests.at(-1)!.body)).not.toContain("Repository map")
      await Bun.sleep(1500) // by the last turn the background build of 14 files has long finished
    }
    expect(fs.readdirSync(codeintelDir(srv)).some((f) => f.endsWith(".db"))).toBe(true)
  }, 90_000)
})

describe("prompt bytes", () => {
  async function capture(features: string | undefined) {
    gw = startMockGateway({ models: { [KEY]: [MODEL] } })
    srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: features === undefined ? {} : { EZK_FEATURES: features }, seed: (d) => seedProject(d.project, 210) })
    const req = features?.includes("+repomap") ? { body: (await heavyTurnWithMap(srv, gw)).body } : await (async () => {
      const s = await newSession(srv!)
      await prompt(srv!, s.id, HEAVY, MODEL)
      return gw!.requests.at(-1)!
    })()
    const norm = (v: unknown) => JSON.stringify(v).split(srv!.dir).join("<TMP>")
    const result = { system: norm(req.body.messages.filter((m: any) => m.role === "system")), tools: norm(req.body.tools), users: norm(req.body.messages.filter((m: any) => m.role === "user")) }
    await srv.stop()
    gw.stop()
    srv = gw = undefined
    return result
  }

  test("repo map on, heavy turn: system prompt and tool list identical to off; only the user message grows", async () => {
    const off = await capture(undefined)
    const on = await capture("+repomap")
    expect(on.system).toBe(off.system)
    expect(on.tools).toBe(off.tools)
    expect(on.users).not.toBe(off.users)
    expect(on.users).toContain("Repository map")
  }, 180_000)
})
