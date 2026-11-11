// C2 compaction recipe against the real server and a local mock gateway.
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { startMockGateway, type Step } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
const FLASH = "deepseek-v4.1-flash"
const PRO = "deepseek-v4-pro-0813"
const MODELS = [FLASH, "minimax-m3.1-flash", PRO]
let srv: Server | undefined
let gw: ReturnType<typeof startMockGateway> | undefined

afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

function gitInit(dir: string) {
  const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir })
  run("init", "-q")
  fs.writeFileSync(path.join(dir, "README.md"), "# compaction\n")
  run("add", "-A")
  run("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "init")
}

async function start(features: string, opts: { config?: Record<string, unknown>; seed?: (d: Server["dirs"]) => void } = {}) {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({
    baseURL: gw.baseURL,
    key: KEY,
    env: { EZK_FEATURES: features, EZK_TRUST_PROJECT: "1" },
    config: { permission: { read: "allow", edit: "allow", bash: "allow" }, ...opts.config },
    seed: (dirs) => {
      gitInit(dirs.project)
      fs.mkdirSync(path.join(dirs.config, "ezkielyna", "ezk"), { recursive: true })
      fs.writeFileSync(path.join(dirs.config, "ezkielyna", "ezk", "model-policy.json"), JSON.stringify({
        flash: [FLASH],
        chains: { light: [FLASH] },
        models: { [PRO]: { agentContext: 1_000_000 } },
      }))
      opts.seed?.(dirs)
    },
  })
  return srv
}

test("C2: read outputs clear before a focused Flash summary with plan and last-read files restored", async () => {
  const s = await start("-router,-memory,-search,+compaction,+planApproval", {
    config: {
      ezk: { router: { policyURL: "" }, compaction: { enabled: true }, planApproval: { enabled: true } },
    },
  })
  const ses = await newSession(s, { permission: [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: `${s.dirs.project}/*`, action: "allow" },
  ] })
  const planDir = path.join(s.dirs.data, "ezkielyna", "ezk", "sessions", ses.id)
  fs.mkdirSync(planDir, { recursive: true })
  fs.writeFileSync(path.join(planDir, "plan.md"), "1. Keep the public migration API backwards compatible.\n2. Add coverage before switching storage.\n")
  fs.writeFileSync(path.join(planDir, "plan.json"), JSON.stringify({ messageID: "msg_test", mode: "ask", at: 1 }))
  const source = path.join(s.dirs.project, "src", "db.ts")
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, 'export const migrationMode = "safe";\n')
  gw!.script[PRO] = [
    { ok: true, tool: { name: "read", args: { filePath: source } } },
    { ok: true, tool: { name: "read", args: { filePath: source } } },
    { ok: true, text: "Read the migration file twice." },
    { ok: true, text: "Second turn complete." },
    { ok: true, text: "Third turn complete." },
  ]

  await prompt(s, ses.id, "Read the migration file twice, then explain it.", PRO)
  await prompt(s, ses.id, "Keep the current migration plan in mind.", PRO)
  await prompt(s, ses.id, "What remains to be done?", PRO)
  const before = await s.api<any[]>("GET", `/session/${ses.id}/message`)
  const readParts = before.flatMap((message) => message.parts
    .filter((part: any) => part.type === "tool" && part.tool === "read" && part.state.status === "completed")
    .map((part: any) => ({ messageID: message.info.id, part })))
  expect(readParts.length).toBe(2)
  for (const { messageID, part } of readParts) {
    await s.api("PATCH", `/session/${ses.id}/message/${messageID}/part/${part.id}`, {
      ...part,
      state: { ...part.state, output: "old result line\n".repeat(25_000) },
    })
  }
  await s.api("POST", `/session/${ses.id}/summarize`, {
    providerID: "ezkielyna",
    modelID: PRO,
    focus: "Keep migration risks and backward compatibility visible.\nRetain the exact next step.",
  })

  const summary = gw!.requests.findLast((request) => request.tools === 0)
  expect(summary?.model).toBe(FLASH)
  const body = JSON.stringify(summary?.body.messages)
  for (const text of [
    "Keep migration risks and backward compatibility visible.",
    "Retain the exact next step.",
    "Approved plan to restore after compaction",
    "backwards compatible",
    `Recently read file ${source}`,
    "## Open TODOs",
  ]) expect(body).toContain(text)
  const messages = await s.api<any[]>("GET", `/session/${ses.id}/message`)
  const cleared = messages.flatMap((message) => message.parts)
    .filter((part: any) => part.type === "tool" && part.tool === "read" && part.state.time.compacted)
  expect(cleared.length).toBeGreaterThan(0)
  expect(cleared[0].state.output).toBe("[output dibuang saat ringkasan: 25000 baris]")
}, 180_000)

test("C2 enabled on an ordinary turn leaves the prompt fingerprint unchanged", async () => {
  const capture = async (features: string) => {
    const s = await start(features, { config: { ezk: { router: { policyURL: "" }, compaction: { enabled: true } } } })
    const ses = await newSession(s)
    await prompt(s, ses.id, "say hi", FLASH)
    const request = gw!.requests[0]!
    const normalized = JSON.stringify(request.body.messages.filter((message: any) => message.role === "system"))
      .split(s.dir).join("<TMP>")
    const fingerprint = createHash("sha256").update(normalized + JSON.stringify(request.body.tools)).digest("hex")
    await s.stop()
    gw!.stop()
    srv = gw = undefined
    return fingerprint
  }
  const baseline = await capture("-router,-memory,-search")
  const enabled = await capture("-router,-memory,-search,+compaction")
  expect(enabled).toBe(baseline)
}, 180_000)
