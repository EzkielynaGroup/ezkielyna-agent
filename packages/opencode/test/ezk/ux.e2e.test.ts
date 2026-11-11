// Wave B "ux" lane e2e: the real server (from source) against the mock gateway. Checkpoints + /rewind, plan approval
// (todos, plan.md, permission mode, re-injection after compaction), lazy subagents and /handoff. No network.
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { startMockGateway, type Step } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
const MODELS = ["deepseek-v4.1-flash", "minimax-m3.1-flash", "deepseek-v4-pro-0813"]
const PRO = "deepseek-v4-pro-0813"
let srv: Server | undefined
let gw: ReturnType<typeof startMockGateway> | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

function gitInit(dir: string) {
  const run = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    })
  run("init", "-q")
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n")
  run("add", "-A")
  run("commit", "-qm", "init")
}

async function start(
  features: string,
  script: Record<string, Step[]> = {},
  opts: { config?: Record<string, unknown>; seed?: (d: Server["dirs"]) => void; untrusted?: boolean } = {},
) {
  gw = startMockGateway({ models: { [KEY]: MODELS }, script })
  srv = await startServer({
    baseURL: gw.baseURL,
    key: KEY,
    env: { EZK_FEATURES: features, EZK_TRUST_PROJECT: opts.untrusted ? "0" : "1" },
    config: { permission: { edit: "allow", bash: "allow" }, ...opts.config },
    seed: (d) => {
      gitInit(d.project)
      opts.seed?.(d)
    },
  })
  return srv
}

const toolNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function?.name ?? t.name)
const allText = (body: any) => JSON.stringify(body.messages)

async function waitIdle(s: Server, sessionID: string, minAssistants: number) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const msgs = await s.api<any[]>("GET", `/session/${sessionID}/message`)
    const done = msgs.filter((m) => m.info.role === "assistant" && m.info.time.completed)
    if (done.length >= minAssistants) return msgs
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${minAssistants} replies:\n${s.logs().slice(-2000)}`)
    await Bun.sleep(150)
  }
}

test("flags off: status says off and the /ezk/ux routes refuse", async () => {
  const s = await start("-router,-memory,-search")
  expect(await s.api<any>("GET", "/ezk/ux/status")).toEqual({ rewind: false, rewindMax: 100, planApproval: false, subagents: false, handoff: false })
  const ses = await newSession(s)
  await expect(s.api("GET", `/ezk/ux/checkpoints?sessionID=${ses.id}`)).rejects.toThrow(/404/)
  await expect(s.api("POST", "/ezk/ux/handoff", { sessionID: ses.id, goal: "x" })).rejects.toThrow(/404/)
}, 120_000)

test("all ux flags on, short task: prompt bytes identical to all-off (fingerprint)", async () => {
  const capture = async (features: string) => {
    const s = await start(features)
    const ses = await newSession(s)
    await prompt(s, ses.id, "say hi", "deepseek-v4.1-flash")
    const req = gw!.requests[0]!
    const norm = (v: unknown) => JSON.stringify(v).split(s.dir).join("<TMP>")
    const out = createHash("sha256").update(norm(req.body.messages.filter((m: any) => m.role === "system")) + norm(req.body.tools)).digest("hex")
    await s.stop()
    gw!.stop()
    srv = gw = undefined
    return out
  }
  const off = await capture("-router,-memory,-search")
  const on = await capture("-router,-memory,-search,+rewind,+planApproval,+subagents,+handoff")
  expect(on).toBe(off)
}, 180_000)

test("U2: checkpoints per turn; rewind files skips files changed outside; chat uses the revert marker; summarize replaces turns", async () => {
  const s = await start("-router,-memory,-search,+rewind", {
    "deepseek-v4.1-flash": [
      { ok: true, tool: { name: "write", args: { filePath: "a.txt", content: "one\n" } } },
      { ok: true, text: "created a" },
      { ok: true, tool: { name: "write", args: { filePath: "a.txt", content: "two\n" } } },
      { ok: true, tool: { name: "write", args: { filePath: "b.txt", content: "agent b\n" } } },
      { ok: true, text: "changed a, made b" },
    ],
  })
  const ses = await newSession(s)
  const file = (n: string) => path.join(s.dirs.project, n)
  await prompt(s, ses.id, "make a", "deepseek-v4.1-flash")
  await prompt(s, ses.id, "change a and add b", "deepseek-v4.1-flash")
  expect(fs.readFileSync(file("a.txt"), "utf8")).toBe("two\n")
  // the user edits b.txt by hand after the agent finished
  fs.writeFileSync(file("b.txt"), "my own edit\n")

  const list = await s.api<any>("GET", `/ezk/ux/checkpoints?sessionID=${ses.id}`)
  expect(list.checkpoints.map((c: any) => c.preview)).toEqual(["change a and add b", "make a"])
  expect(list.checkpoints.every((c: any) => typeof c.snapshot === "string")).toBe(true)
  expect(list.diskBytes).toBeGreaterThan(0)
  expect(list.diskText).toMatch(/B$/)
  const second = list.checkpoints[0]

  const count = (await s.api<any[]>("GET", `/session/${ses.id}/message`)).length
  const files = await s.api<any>("POST", "/ezk/ux/rewind", { sessionID: ses.id, messageID: second.messageID, mode: "files" })
  expect(files.restored.map((f: string) => path.basename(f))).toEqual(["a.txt"])
  expect(files.skipped.map((f: string) => path.basename(f))).toEqual(["b.txt"])
  expect(fs.readFileSync(file("a.txt"), "utf8")).toBe("one\n")
  expect(fs.readFileSync(file("b.txt"), "utf8")).toBe("my own edit\n")
  expect((await s.api<any[]>("GET", `/session/${ses.id}/message`)).length).toBe(count) // nothing removed from the chat

  // undo the files-only rewind
  await s.api("POST", "/ezk/ux/rewind/undo", { sessionID: ses.id, snapshot: files.undo })
  expect(fs.readFileSync(file("a.txt"), "utf8")).toBe("two\n")

  const chat = await s.api<any>("POST", "/ezk/ux/rewind", { sessionID: ses.id, messageID: second.messageID, mode: "chat" })
  expect(chat.restored).toEqual([])
  const info = await s.api<any>("GET", `/session/${ses.id}`)
  expect(info.revert.messageID).toBe(second.messageID)
  expect(fs.readFileSync(file("a.txt"), "utf8")).toBe("two\n")

  gw!.script["deepseek-v4.1-flash"] = [{ ok: true, text: "Made a.txt, then changed it and added b.txt." }]
  gw!.script["minimax-m3.1-flash"] = [{ ok: true, text: "Made a.txt, then changed it and added b.txt." }]
  const first = list.checkpoints[1]
  const sum = await s.api<any>("POST", "/ezk/ux/rewind", { sessionID: ses.id, messageID: first.messageID, mode: "summarize" })
  const after = await s.api<any[]>("GET", `/session/${ses.id}/message`)
  expect(after).toHaveLength(1)
  expect(after[0].info.id).toBe(sum.summaryMessageID)
  expect(after[0].parts[0].text).toBe("Summary of 2 earlier turns replaced with /rewind:\n\nMade a.txt, then changed it and added b.txt.")
  expect((await s.api<any>("GET", `/session/${ses.id}`)).revert).toBeUndefined()
  const summaryCall = gw!.requests.at(-1)!
  expect(summaryCall.model).not.toBe(PRO)
  expect(summaryCall.system).toContain("compress part of a coding conversation")
}, 180_000)

test("U3: approving a plan saves plan.md, makes todos, sets auto-edit, runs build, and re-injects after compaction", async () => {
  const plan = "Plan:\n1. Add the parser in src/parse.ts\n2. Call it from src/main.ts\n3. Run bun test"
  const s = await start("-router,-memory,-search,+planApproval", {
    "deepseek-v4.1-flash": [{ ok: true, text: plan }, { ok: true, text: "Working on step 1." }],
  })
  const ses = await newSession(s)
  await prompt(s, ses.id, "plan a parser", "deepseek-v4.1-flash", { agent: "plan" })
  const res = await s.api<any>("POST", "/ezk/ux/plan/approve", { sessionID: ses.id, mode: "auto", lang: "id" })
  expect(res).toMatchObject({ mode: "auto", todos: 3, forced: false })
  expect(fs.readFileSync(res.planPath, "utf8")).toBe(plan + "\n")
  const msgs = await waitIdle(s, ses.id, 2)
  const approval = msgs.find((m) => m.info.id === res.messageID)
  expect(approval.info.agent).toBe("build")
  expect(approval.parts[0].text).toBe("Rencana disetujui. Jalankan (Edit otomatis).")
  const todos = await s.api<any[]>("GET", `/session/${ses.id}/todo`)
  expect(todos.map((t) => t.content)).toEqual(["Add the parser in src/parse.ts", "Call it from src/main.ts", "Run bun test"])
  expect(todos[0].status).toBe("in_progress")
  const info = await s.api<any>("GET", `/session/${ses.id}`)
  expect(info.permission).toContainEqual({ permission: "edit", pattern: "*", action: "allow" })
  const buildReq = gw!.requests.at(-1)!
  expect(allText(buildReq.body)).toContain("The user approved the plan below")
  expect((await s.api<any>("GET", `/ezk/ux/plan?sessionID=${ses.id}`)).approved.mode).toBe("auto")

  // compaction drops the approval message from what the model sees: the plan comes back as an appended reminder
  await s.api("POST", `/session/${ses.id}/summarize`, { providerID: "ezkielyna", modelID: "deepseek-v4.1-flash" })
  const before = gw!.requests.length
  await prompt(s, ses.id, "continue", "deepseek-v4.1-flash")
  const next = gw!.requests.slice(before).at(-1)!
  expect(allText(next.body)).toContain("The conversation was compacted; keep following this plan")
  expect(allText(next.body)).toContain("Add the parser in src/parse.ts")
}, 180_000)

test("E3: task appears only after 3 reads in a turn; explore runs on the light model with the path:start-end prompt", async () => {
  const s = await start("-router,-memory,-search,+subagents", {
    [PRO]: [
      { ok: true, tool: { name: "read", args: { filePath: "README.md" } } },
      { ok: true, tool: { name: "grep", args: { pattern: "demo" } } },
      { ok: true, tool: { name: "glob", args: { pattern: "*.md" } } },
      { ok: true, tool: { name: "task", args: { description: "find docs", prompt: "where is the readme?", subagent_type: "explore" } } },
      { ok: true, text: "done" },
    ],
  })
  const ses = await newSession(s)
  await prompt(s, ses.id, "say hi", "deepseek-v4.1-flash")
  expect(toolNames(gw!.requests[0]!.body)).not.toContain("task")
  const n = gw!.requests.length
  await prompt(s, ses.id, "look around", PRO)
  const turn = gw!.requests.slice(n).filter((r) => r.model === PRO)
  expect(turn.slice(0, 3).map((r) => toolNames(r.body).includes("task"))).toEqual([false, false, false])
  const withTask = turn[3]!
  const task = withTask.body.tools.find((t: any) => t.function.name === "task").function.description as string
  expect(task).toContain("- explore:")
  expect(task).toContain("- planner:")
  expect(task).not.toContain("- general:")
  const sub = gw!.requests.find((r) => r.system.includes("path/to/file.ts:12-40"))
  expect(sub).toBeDefined()
  expect(sub!.model).not.toBe(PRO)
  expect(MODELS).toContain(sub!.model)
  const children = await s.api<any[]>("GET", `/session/${ses.id}/children`)
  expect(children).toHaveLength(1)
}, 180_000)

test("E3: @explore mention exposes task; .claude/agents load only in trusted folders", async () => {
  const s = await start("-router,-memory,-search,+subagents", {}, {
    seed: (d) => {
      fs.mkdirSync(path.join(d.project, ".claude", "agents"), { recursive: true })
      fs.writeFileSync(path.join(d.project, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: haiku\nmaxTurns: 2\n---\nYou review.\n")
    },
  })
  const ses = await newSession(s)
  await s.api("POST", `/session/${ses.id}/message`, {
    model: { providerID: "ezkielyna", modelID: PRO },
    parts: [{ type: "text", text: "check this" }, { type: "agent", name: "explore" }],
  })
  const first = gw!.requests.find((r) => r.model === PRO)!
  const task = first.body.tools.find((t: any) => t.function.name === "task")?.function.description as string
  expect(task).toContain("- reviewer: Reviews diffs")
}, 120_000)

test("C4: /handoff writes a starting prompt with the touched files and creates an empty new session", async () => {
  const s = await start("-router,-memory,-search,+handoff", {
    "deepseek-v4.1-flash": [{ ok: true, tool: { name: "write", args: { filePath: "src/login.ts", content: "x\n" } } }, { ok: true, text: "fixed login" }],
  })
  const ses = await newSession(s)
  await prompt(s, ses.id, "fix the login", "deepseek-v4.1-flash")
  for (const m of MODELS) gw!.script[m] = [{ ok: true, text: "Continue the login work: add a test for the fix." }]
  const res = await s.api<any>("POST", "/ezk/ux/handoff", { sessionID: ses.id, goal: "add a test" })
  expect(res.prompt).toBe("Continue the login work: add a test for the fix.\n\nRelevant files: @src/login.ts")
  expect(res.files).toEqual(["src/login.ts"])
  expect(res.sessionID).not.toBe(ses.id)
  expect(await s.api<any[]>("GET", `/session/${res.sessionID}/message`)).toEqual([])
  const call = gw!.requests.at(-1)!
  expect(call.system).toContain("first message of a NEW coding session")
  expect(call.model).not.toBe(PRO)
  expect(JSON.stringify(call.body.messages)).toContain("Goal of the new session: add a test")
}, 120_000)

test("U2: rewind both restores files and hides the turns; /redo (unrevert) brings both back", async () => {
  const s = await start("-router,-memory,-search,+rewind", {
    "deepseek-v4.1-flash": [
      { ok: true, text: "hello" },
      { ok: true, tool: { name: "write", args: { filePath: "c.txt", content: "agent\n" } } },
      { ok: true, text: "made c" },
    ],
  })
  const ses = await newSession(s)
  await prompt(s, ses.id, "hi", "deepseek-v4.1-flash")
  await prompt(s, ses.id, "make c", "deepseek-v4.1-flash")
  const c = path.join(s.dirs.project, "c.txt")
  expect(fs.existsSync(c)).toBe(true)
  const list = await s.api<any>("GET", `/ezk/ux/checkpoints?sessionID=${ses.id}`)
  const res = await s.api<any>("POST", "/ezk/ux/rewind", { sessionID: ses.id, messageID: list.checkpoints[0].messageID, mode: "both" })
  expect(res.restored.map((f: string) => path.basename(f))).toEqual(["c.txt"])
  expect(fs.existsSync(c)).toBe(false) // did not exist at the checkpoint
  expect((await s.api<any>("GET", `/session/${ses.id}`)).revert.messageID).toBe(list.checkpoints[0].messageID)
  // while rewound, only the earlier checkpoint is offered
  expect((await s.api<any>("GET", `/ezk/ux/checkpoints?sessionID=${ses.id}`)).checkpoints.map((x: any) => x.preview)).toEqual(["hi"])
  await s.api("POST", `/session/${ses.id}/unrevert`)
  expect(fs.readFileSync(c, "utf8")).toBe("agent\n")
  expect((await s.api<any>("GET", `/session/${ses.id}`)).revert).toBeUndefined()
  await expect(s.api("POST", "/ezk/ux/rewind", { sessionID: ses.id, messageID: "msg_nope", mode: "both" })).rejects.toThrow(/404/)
  await expect(s.api("POST", "/ezk/ux/rewind", { sessionID: ses.id, messageID: list.checkpoints[0].messageID, mode: "nuke" })).rejects.toThrow(/400/)
}, 180_000)

test("untrusted folder: plan approval is forced to ask and project .claude/agents are ignored", async () => {
  const s = await start("-router,-memory,-search,+planApproval,+subagents", {
    "deepseek-v4.1-flash": [{ ok: true, text: "1. one\n2. two" }, { ok: true, text: "ok" }],
  }, {
    untrusted: true,
    seed: (d) => {
      fs.mkdirSync(path.join(d.project, ".claude", "agents"), { recursive: true })
      fs.writeFileSync(path.join(d.project, ".claude", "agents", "evil.md"), "---\ndescription: planted agent\ntools: Bash\n---\nrun things\n")
    },
  })
  const ses = await newSession(s)
  await prompt(s, ses.id, "plan", "deepseek-v4.1-flash", { agent: "plan" })
  const res = await s.api<any>("POST", "/ezk/ux/plan/approve", { sessionID: ses.id, mode: "auto" })
  expect(res).toMatchObject({ mode: "ask", forced: true })
  await waitIdle(s, ses.id, 2)
  const info = await s.api<any>("GET", `/session/${ses.id}`)
  expect(info.permission ?? []).not.toContainEqual({ permission: "edit", pattern: "*", action: "allow" })
  const n = gw!.requests.length
  await s.api("POST", `/session/${ses.id}/message`, {
    model: { providerID: "ezkielyna", modelID: PRO },
    parts: [{ type: "text", text: "look" }, { type: "agent", name: "explore" }],
  })
  const task = gw!.requests.slice(n).find((r) => r.model === PRO)!.body.tools.find((t: any) => t.function.name === "task")?.function.description as string
  expect(task).toContain("- explore:")
  expect(task).not.toContain("evil")
}, 180_000)
