import fs from "node:fs"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
const FLASH = "deepseek-v4.1-flash"
const MODELS = ["deepseek-v4-pro-0813", FLASH, "minimax-m3.1-flash"]
let srv: Server | undefined
let gw: ReturnType<typeof startMockGateway> | undefined

afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

async function boot(features: string, seed?: (dirs: Server["dirs"]) => void, trusted = true) {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: `${features},-skills`, EZK_TRUST_PROJECT: trusted ? "1" : "0" }, seed })
  return { srv, gw }
}

const permissions = (server: Server) => [
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: `${server.dirs.project}/*`, action: "allow" },
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "todowrite", pattern: "*", action: "allow" },
]

function manifest(dirs: Server["dirs"], typecheck: string) {
  fs.writeFileSync(path.join(dirs.project, "package.json"), JSON.stringify({
    name: "verify-fixture",
    private: true,
    packageManager: "bun@1.0.0",
    scripts: { typecheck },
  }))
}

function requestText(index: number) {
  return JSON.stringify(gw!.requests[index]!.body.messages)
}

async function messages(sessionID: string) {
  const result = await srv!.api("GET", `/session/${sessionID}/message`)
  return (result?.data ?? result ?? []) as any[]
}

test("verify command runs after edits with a 120 second timeout and accepts exit 0", async () => {
  const { srv, gw } = await boot("-router,-memory,-search,+loop.verify", (dirs) => manifest(dirs, "true"))
  gw.script[FLASH] = [
    { ok: true, tool: { name: "write", args: { filePath: path.join(srv.dirs.project, "change.ts"), content: "export const ok = true" } } },
    { ok: true, text: "The edit is ready." },
    { ok: true, tool: { name: "bash", args: { command: "bun run typecheck", timeout: 1 } } },
    { ok: true, text: "Verification passed." },
  ]
  const session = await newSession(srv, { permission: permissions(srv) })
  await prompt(srv, session.id, "fix this file", FLASH)

  expect(gw.requests).toHaveLength(4)
  expect(requestText(2)).toContain("Run this detected project verify command")
  expect(requestText(2)).toContain("bun run typecheck")
  const tool = (await messages(session.id)).flatMap((message) => message.parts ?? []).find((part: any) => part.type === "tool" && part.tool === "bash")
  expect(tool?.state?.input).toMatchObject({ command: "bun run typecheck", timeout: 120_000 })
}, 90_000)

test("failed verification feeds the tail back, allows a fix, then passes", async () => {
  const { srv, gw } = await boot("-router,-memory,-search,+loop.verify", (dirs) => manifest(dirs, "test -f .verify-ok"))
  gw.script[FLASH] = [
    { ok: true, tool: { name: "write", args: { filePath: path.join(srv.dirs.project, "change.ts"), content: "export const ok = true" } } },
    { ok: true, text: "The edit is ready." },
    { ok: true, tool: { name: "bash", args: { command: "bun run typecheck" } } },
    { ok: true, tool: { name: "write", args: { filePath: path.join(srv.dirs.project, ".verify-ok"), content: "fixed" } } },
    { ok: true, text: "I fixed the failing check." },
    { ok: true, tool: { name: "bash", args: { command: "bun run typecheck" } } },
    { ok: true, text: "Verification passed." },
  ]
  const session = await newSession(srv, { permission: permissions(srv) })
  await prompt(srv, session.id, "fix this file", FLASH)

  expect(gw.requests).toHaveLength(7)
  expect(requestText(3)).toContain("Project verification failed (round 1/3)")
  expect(requestText(3)).toContain("bun run typecheck")
  expect(requestText(5)).toContain("Run this detected project verify command")
  const tools = (await messages(session.id)).flatMap((message) => message.parts ?? []).filter((part: any) => part.type === "tool" && part.tool === "bash")
  expect(tools).toHaveLength(2)
  expect(tools[1]?.state?.metadata?.exit).toBe(0)
}, 120_000)

test("three failed verify rounds stop with an honest report", async () => {
  const { srv, gw } = await boot("-router,-memory,-search,+loop.verify", (dirs) => manifest(dirs, "false"))
  gw.script[FLASH] = [
    { ok: true, tool: { name: "write", args: { filePath: path.join(srv.dirs.project, "change.ts"), content: "export const ok = true" } } },
    { ok: true, text: "The edit is ready." },
    { ok: true, tool: { name: "bash", args: { command: "bun run typecheck" } } },
    { ok: true, text: "I will inspect and retry." },
    { ok: true, tool: { name: "bash", args: { command: "bun run typecheck" } } },
    { ok: true, text: "I will retry once more." },
    { ok: true, tool: { name: "bash", args: { command: "bun run typecheck" } } },
    { ok: true, text: "masih gagal setelah 3 percobaan: bun run typecheck" },
  ]
  const session = await newSession(srv, { permission: permissions(srv) })
  await prompt(srv, session.id, "fix this file", FLASH)

  expect(gw.requests).toHaveLength(8)
  expect(requestText(7)).toContain("masih gagal setelah 3 percobaan")
  expect((await messages(session.id)).flatMap((message) => message.parts ?? []).filter((part: any) => part.type === "tool" && part.tool === "bash")).toHaveLength(3)
}, 120_000)

test("project verification is skipped in a non-code folder", async () => {
  const { srv, gw } = await boot("-router,-memory,-search,+loop.verify")
  gw.script[FLASH] = [
    { ok: true, tool: { name: "write", args: { filePath: path.join(srv.dirs.project, "note.txt"), content: "done" } } },
    { ok: true, text: "Done; no project verify command was detected." },
  ]
  const session = await newSession(srv, { permission: permissions(srv) })
  await prompt(srv, session.id, "write a short note", FLASH)

  expect(gw.requests).toHaveLength(2)
  expect(JSON.stringify(gw.requests)).not.toContain("Run this detected project verify command")
}, 90_000)

test("heavy tasks create and update a todo plan while light questions do not", async () => {
  const { srv, gw } = await boot("-router,-memory,-search,+loop.plan")
  gw.script[FLASH] = [
    { ok: true, tool: { name: "todowrite", args: { todos: [{ content: "Refactor the service", status: "pending", priority: "high" }] } } },
    { ok: true, text: "Plan created; starting implementation." },
    { ok: true, text: "I re-read and updated the plan." },
  ]
  const session = await newSession(srv, { permission: permissions(srv) })
  await prompt(srv, session.id, "Refactor the service into a few clear modules", FLASH)
  await prompt(srv, session.id, "run tests now", FLASH)

  expect(gw.requests).toHaveLength(3)
  expect(requestText(0)).toContain("create a short numbered plan with todowrite")
  expect(requestText(1)).toContain("The plan is now active")
  expect(requestText(2)).toContain("phase change")
  const todos = (await messages(session.id)).flatMap((message) => message.parts ?? []).filter((part: any) => part.type === "tool" && part.tool === "todowrite")
  expect(todos).toHaveLength(1)
}, 120_000)

test("plan approval hands heavy work to the plan agent and waits", async () => {
  const { srv, gw } = await boot("-router,-memory,-search,+loop.plan,+planApproval")
  gw.script[FLASH] = [{ ok: true, text: "1. Inspect the service.\n2. Add the cache.\n3. Verify behavior." }]
  const session = await newSession(srv, { permission: permissions(srv) })
  await prompt(srv, session.id, "Implement caching across the service", FLASH)

  expect(gw.requests).toHaveLength(1)
  expect(requestText(0)).toContain("wait for the plan approval card")
  const assistant = (await messages(session.id)).findLast((message) => message.info?.role === "assistant")
  expect(assistant?.info?.agent).toBe("plan")
}, 90_000)

test("untrusted project config cannot enable plan approval", async () => {
  const { srv, gw } = await boot("-router,-memory,-search,+loop.plan", (dirs) => {
    fs.writeFileSync(path.join(dirs.project, "ezkielyna.json"), JSON.stringify({ ezk: { planApproval: { enabled: true } } }))
  }, false)
  gw.script[FLASH] = [{ ok: true, text: "I will first inspect the service, then make the requested change." }]
  const session = await newSession(srv)
  await prompt(srv, session.id, "Implement caching across the service", FLASH)

  expect(gw.requests).toHaveLength(1)
  expect(requestText(0)).not.toContain("wait for the plan approval card")
  const assistant = (await messages(session.id)).findLast((message) => message.info?.role === "assistant")
  expect(assistant?.info?.agent).not.toBe("plan")
}, 90_000)

test("light question receives no forced plan", async () => {
  const { srv, gw } = await boot("-router,-memory,-search,+loop.plan")
  gw.script[FLASH] = [{ ok: true, text: "It returns the cached value when present." }]
  const session = await newSession(srv)
  await prompt(srv, session.id, "What does this helper do?", FLASH)

  expect(gw.requests).toHaveLength(1)
  expect(requestText(0)).not.toContain("short numbered plan with todowrite")
}, 90_000)

test("shared intent keeps fix questions out of A5 and direct repairs inside A10", async () => {
  const { srv, gw } = await boot("-router,-memory,-search,+loop.plan,+context.reproduce")
  gw.script[FLASH] = [
    { ok: true, text: "I can explain the repository-wide fix approach without editing anything." },
    { ok: true, text: "I will reproduce the reported behavior first." },
  ]
  const session = await newSession(srv)
  await prompt(srv, session.id, "How do I fix this across the whole repo?", FLASH)
  await prompt(srv, session.id, "Can you fix this?", FLASH)

  expect(gw.requests).toHaveLength(2)
  expect(requestText(0)).not.toContain("short numbered plan with todowrite")
  expect(requestText(0)).not.toContain("<bug_fix_protocol>")
  expect(requestText(1)).toContain("<bug_fix_protocol>")
}, 90_000)
