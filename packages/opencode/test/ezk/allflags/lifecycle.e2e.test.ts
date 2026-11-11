// ALL flags: plan approval then execution, /rewind after edits, compaction triggered mid-task by a small fake window.
import fs from "node:fs"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import {
  ALL_FLAGS, FLASH, QUIET, allowAll, boot, bodyText, expectCleanLogs, expectNoDuplicateReminders, expectNoDuplicateTools,
  expectStablePrefix, expectToolCallsAnswered, flagList, messages, newSession, prompt, promptAnswering, systemOf, toolNames, toolParts,
  mainRequests,
} from "./helpers"
import { teardown } from "./helpers"

const rejections: unknown[] = []
process.on("unhandledRejection", (e) => rejections.push(e))
afterEach(async () => {
  await teardown()
  expect(rejections).toEqual([])
})

async function waitIdle(srv: any, id: string, n: number) {
  const end = Date.now() + 30_000
  for (;;) {
    const msgs = await messages(srv, id)
    if (msgs.filter((m) => m.info.role === "assistant" && m.info.time.completed).length >= n) return msgs
    if (Date.now() > end) throw new Error("timeout waiting for replies")
    await Bun.sleep(150)
  }
}

const WITHOUT_LOOP_PLAN = ALL_FLAGS.filter((f) => f !== "loop.plan")

async function planThenExecute(flags: string[]) {
  const plan = "Plan:\n1. Add src/parse.ts\n2. Run the tests"
  const { gw, srv } = await boot({
    flags: `${QUIET},${flagList(flags)}`,
    script: {
      [FLASH]: [
        { ok: true, text: plan },
        { ok: true, tool: { name: "write", args: { filePath: "src/parse.ts", content: "export const parse = (s: string) => s\n" } } },
        { ok: true, text: "Step 1 done." },
        { ok: true, text: "Verified: the file exists." }, // loop.verificationGate adds one more model call after an edit turn
      ],
    },
  })
  const ses = await newSession(srv)
  await prompt(srv, ses.id, "plan a parser", FLASH, { agent: "plan" })
  const res = await srv.api<any>("POST", "/ezk/ux/plan/approve", { sessionID: ses.id, mode: "auto", lang: "en" })
  expect(res).toMatchObject({ mode: "auto", todos: 2, forced: false })
  const msgs = await waitIdle(srv, ses.id, 2)
  return { gw, srv, ses, res, msgs }
}

test("all flags except loop.plan: plan approval then execution (build agent, todos, auto-edit) with stable bytes", async () => {
  const { gw, srv, res, msgs } = await planThenExecute(WITHOUT_LOOP_PLAN)
  expect(msgs.find((m) => m.info.id === res.messageID).info.agent).toBe("build")
  expect(fs.readFileSync(path.join(srv.dirs.project, "src", "parse.ts"), "utf8")).toContain("parse")
  expect(bodyText(gw.requests.at(-1)!)).toContain("The user approved the plan below")
  expectNoDuplicateTools(gw)
  expectNoDuplicateReminders(gw)
  expectToolCallsAnswered(gw)
  // the build turns after the approval share one system prompt and tool list
  const builds = gw.requests.filter((r) => bodyText(r).includes("The user approved the plan below"))
  for (const r of builds.slice(1)) {
    expect(systemOf(r)).toBe(systemOf(builds[0]!))
    expect(toolNames(r)).toEqual(toolNames(builds[0]!))
  }
  expectCleanLogs(srv)
}, 180_000)

// BUG-3 (REPORT-allflags.md): with loop.plan on, the approval message of a heavy task is forced back to the plan agent
// (plugin/ezk/router.ts:76-78), so execution never leaves plan mode. Passes while the bug exists; drop `.failing` after the fix.
test("BUG-3: all flags: the approved plan runs as the build agent", async () => {
  const { msgs, res } = await planThenExecute(ALL_FLAGS)
  expect(msgs.find((m) => m.info.id === res.messageID).info.agent).toBe("build")
}, 180_000)

test("all flags: /rewind after edits restores files, the next turn keeps system and tools unchanged", async () => {
  const { gw, srv } = await boot({
    flags: `${QUIET},${flagList(ALL_FLAGS)}`,
    mode: "acceptEdits",
    script: {
      [FLASH]: [
        { ok: true, tool: { name: "write", args: { filePath: "a.txt", content: "one\n" } } },
        { ok: true, text: "made a" },
        { ok: true, text: "verified a" }, // verification gate round
        { ok: true, tool: { name: "write", args: { filePath: "a.txt", content: "two\n" } } },
        { ok: true, tool: { name: "write", args: { filePath: "b.txt", content: "bee\n" } } },
        { ok: true, text: "changed a, made b" },
        { ok: true, text: "verified a and b" },
        { ok: true, text: "continuing after the rewind" },
      ],
    },
  })
  const file = (n: string) => path.join(srv.dirs.project, n)
  const ses = await newSession(srv)
  await prompt(srv, ses.id, "make a", FLASH)
  await prompt(srv, ses.id, "change a and add b", FLASH)
  const list = await srv.api<any>("GET", `/ezk/ux/checkpoints?sessionID=${ses.id}`)
  expect(list.checkpoints.map((c: any) => c.preview)).toEqual(["change a and add b", "make a"])
  const res = await srv.api<any>("POST", "/ezk/ux/rewind", { sessionID: ses.id, messageID: list.checkpoints[0].messageID, mode: "both" })
  expect(res.restored.map((f: string) => path.basename(f)).sort()).toEqual(["a.txt", "b.txt"])
  expect(fs.readFileSync(file("a.txt"), "utf8")).toBe("one\n")
  expect(fs.existsSync(file("b.txt"))).toBe(false)
  await prompt(srv, ses.id, "continue", FLASH)
  // the rewound turns are gone from what the model sees
  const last = bodyText(gw.requests.at(-1)!)
  expect(last).not.toContain("change a and add b")
  expectStablePrefix(gw)
  expectNoDuplicateTools(gw)
  expectNoDuplicateReminders(gw)
  expectToolCallsAnswered(gw)
  expectCleanLogs(srv)
}, 180_000)

const policy = (d: { config: string }) => {
  // a small fake window through the model policy (agentContext): compaction at 90% of 8000 tokens
  fs.mkdirSync(path.join(d.config, "ezkielyna", "ezk"), { recursive: true })
  fs.writeFileSync(path.join(d.config, "ezkielyna", "ezk", "model-policy.json"), JSON.stringify({ flash: [FLASH], chains: { light: [FLASH] }, models: { [FLASH]: { agentContext: 8_000 } } }))
}
const compactionScript = (): Record<string, any[]> => ({
  [FLASH]: [
    { ok: true, tool: { name: "read", args: { filePath: "README.md" } }, usage: { prompt: 7_600, completion: 50 } },
    { ok: true, text: "## Goal\nfinish the task\n## Open TODOs\n- write done.txt", usage: { prompt: 500, completion: 50 } },
    { ok: true, tool: { name: "write", args: { filePath: "done.txt", content: "done\n" } }, usage: { prompt: 900, completion: 20 } },
    { ok: true, text: "All done.", usage: { prompt: 1000, completion: 20 } },
    { ok: true, text: "Verified: done.txt exists.", usage: { prompt: 1000, completion: 20 } },
    { ok: true, text: "extra", usage: { prompt: 1000, completion: 20 } },
  ],
})

test("all flags: compaction triggers mid-task on a small fake window; task completes; system and tools stay stable", async () => {
  const { gw, srv } = await boot({
    flags: `${QUIET},${flagList(ALL_FLAGS)}`,
    mode: "acceptEdits",
    config: { ezk: { router: { policyURL: "" } } },
    seed: policy,
    script: compactionScript(),
  })
  const ses = await newSession(srv, { permission: allowAll(srv) })
  // the estimate counts messages only: a long pasted log in the prompt (about 12k tokens) puts the history over the window
  const pasted = Array.from({ length: 1600 }, (_, i) => `log ${i} alpha beta gamma delta epsilon`).join("\n")
  await prompt(srv, ses.id, `read README.md, then write done.txt. Context log:\n${pasted}`, FLASH)
  await Bun.sleep(1500)
  if (process.env.EZK_DEBUG_TEST) {
    gw.requests.forEach((r, i) => console.log("DBG req", i, r.model, "tools", r.tools, "msgs", r.messages, JSON.stringify(r.body.messages.at(-1)).slice(0, 150)))
    for (const m of await messages(srv, ses.id)) console.log("DBG msg", m.info.role, m.info.finish, JSON.stringify(m.info.error ?? null).slice(0, 200), m.parts.map((p: any) => p.type).join("|"))
  }
  expect(gw.requests.filter((r) => r.tools === 0).length).toBeGreaterThan(0) // compaction ran
  // BUG-5: the summary input carries no per-turn reminders
  for (const r of gw.requests.filter((r) => r.tools === 0)) expect(bodyText(r)).not.toContain("Permission mode is now")
  const msgs = await messages(srv, ses.id)
  expect(msgs.some((m) => m.parts?.some((p: any) => p.type === "compaction"))).toBe(true)
  // documented break: the history is replaced by the summary; system prompt and tool list must not move
  expectStablePrefix(gw)
  expectNoDuplicateTools(gw)
  expectNoDuplicateReminders(gw)
  expectToolCallsAnswered(gw)
  expect(mainRequests(gw).length).toBeGreaterThan(1)
  expect(fs.existsSync(path.join(srv.dirs.project, "done.txt"))).toBe(true)
  expect(toolParts(msgs).every((p: any) => p.state.status !== "running" && p.state.status !== "pending")).toBe(true)
  expectCleanLogs(srv)
}, 200_000)

// BUG-4 (REPORT-allflags.md): provider-reported tokens say "overflow" but the local estimate (messages only, no system prompt or
// tool schemas) is below the threshold: SessionCompaction.process returns "stop" (session/compaction.ts:479-489) and the
// prompt loop ends the turn (session/prompt.ts:1217) with the task unfinished. Passes while the bug exists.
test("BUG-4: compaction flag: a false overflow near the threshold must not end the task", async () => {
  const { srv } = await boot({
    flags: `${QUIET},+compaction`,
    config: { ezk: { router: { policyURL: "" } } },
    seed: policy,
    script: (() => {
      const sc = compactionScript()
      // small prompt: the estimate stays far below the threshold
      return sc
    })(),
  })
  const ses = await newSession(srv, { permission: allowAll(srv) })
  await prompt(srv, ses.id, "read README.md, then write done.txt", FLASH)
  await Bun.sleep(1500)
  expect(fs.existsSync(path.join(srv.dirs.project, "done.txt"))).toBe(true)
}, 200_000)

// BUG-4b: worse than BUG-4: the same false overflow wedges the session. The last finished assistant message stays above the
// threshold, so every later prompt hits compaction.create -> process -> "stop" (session/prompt.ts:1221-1226) and is dropped
// without a model call and without an error. Passes while the bug exists.
test("BUG-4b: compaction flag: after a false overflow the next prompt is still answered", async () => {
  const { gw, srv } = await boot({
    // -models.metadata: with the policy window applied to the model (ezk.8 default) the fake 8k window is a REAL overflow
    // and compaction legitimately runs; this test is about the false-overflow path, so it keeps the pre-ezk.8 metadata off.
    flags: `${QUIET},+compaction,-models.metadata,-models.vision`,
    config: { ezk: { router: { policyURL: "" } } },
    seed: policy,
    script: { [FLASH]: [
      { ok: true, text: "first answer", usage: { prompt: 7_600, completion: 50 } },
      { ok: true, text: "## Goal\nsay things", usage: { prompt: 300, completion: 50 } }, // the (now real) compaction summary
      { ok: true, text: "second answer", usage: { prompt: 7_600, completion: 50 } },
    ] },
  })
  const ses = await newSession(srv)
  await prompt(srv, ses.id, "say one", FLASH)
  await prompt(srv, ses.id, "say two", FLASH)
  expect(gw.requests.filter((r) => r.tools > 0)).toHaveLength(2)
}, 200_000)
