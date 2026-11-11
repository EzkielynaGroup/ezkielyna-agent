import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_FLAGS, loadFlags } from "../../src/ezk/flags"
import { DEFAULT_POLICY, allowedFrom } from "../../src/ezk/model-policy"
import {
  MAX_CHECKPOINTS,
  diskUsage,
  formatBytes,
  isRewindMode,
  lastAgentSnapshot,
  listCheckpoints,
  planFileRestore,
  summaryDigest,
  summaryMessage,
} from "../../src/ezk/ux/checkpoints"
import { approvalInstruction, approvalText, needsPlanReminder, pendingPlan, planReminder, planTodos } from "../../src/ezk/ux/plan"
import { PlanStore } from "../../src/ezk/ux/store"
import {
  capResult,
  explorePrompt,
  fromClaudeAgent,
  modelSpec,
  normalizeAgent,
  permissionOverlay,
  shouldExposeTask,
  subagentModel,
} from "../../src/ezk/ux/subagents"
import { handoffDigest, handoffFiles, handoffPrompt, handoffRequest } from "../../src/ezk/ux/handoff"
import type { UxMessage, UxPart } from "../../src/ezk/ux/types"

let n = 0
const user = (text: string, extra: UxPart[] = []): UxMessage => ({
  info: { id: `msg_${String(++n).padStart(4, "0")}`, role: "user", time: { created: n } },
  parts: [{ type: "text", text }, ...extra],
})
const assistant = (parts: UxPart[], info: Partial<UxMessage["info"]> = {}): UxMessage => ({
  info: { id: `msg_${String(++n).padStart(4, "0")}`, role: "assistant", time: { created: n, completed: n }, finish: "stop", agent: "build", ...info },
  parts,
})
const tool = (name: string, input: Record<string, unknown> = {}, status = "completed"): UxPart => ({ type: "tool", tool: name, state: { status, input } })

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-ux-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("flags (ux lane)", () => {
  test("all ux items default OFF, with the documented limits", () => {
    const f = loadFlags([dir], {})
    expect(f.rewind).toEqual({ enabled: false, max: 100 })
    expect(f.planApproval.enabled).toBe(false)
    expect(f.subagents).toEqual({ enabled: false, minReads: 3, maxConcurrent: 3, exploreTurns: 4, resultTokens: 2000 })
    expect(f.handoff.enabled).toBe(false)
    expect(f).toEqual(DEFAULT_FLAGS)
  })
  test("EZK_FEATURES turns them on; config limits are read and sanitised", () => {
    fs.writeFileSync(path.join(dir, "ezkielyna.json"), JSON.stringify({ ezk: { rewind: { max: 5 }, subagents: { maxConcurrent: 0, minReads: 2.7 } } }))
    const f = loadFlags([dir], { EZK_FEATURES: "+rewind,+planApproval,+subagents,+handoff" })
    expect([f.rewind.enabled, f.planApproval.enabled, f.subagents.enabled, f.handoff.enabled]).toEqual([true, true, true, true])
    expect(f.rewind.max).toBe(5)
    expect(f.subagents.maxConcurrent).toBe(1)
    expect(f.subagents.minReads).toBe(2)
  })
})

describe("U2 checkpoints", () => {
  const session = () => {
    const u1 = user("first: add a file")
    const a1 = assistant([
      { type: "step-start", snapshot: "tree-1" },
      tool("write", { filePath: "/p/a.ts" }),
      { type: "step-finish", snapshot: "tree-1b" },
      { type: "patch", hash: "tree-1", files: ["/p/a.ts"] },
    ])
    const u2 = user("second: edit b\nmore lines")
    const a2 = assistant([
      { type: "step-start", snapshot: "tree-2" },
      { type: "step-finish", snapshot: "tree-2b" },
      { type: "patch", hash: "tree-2", files: ["/p/b.ts", "/p/a.ts"] },
    ])
    const synthetic = { info: { id: "msg_9000", role: "user" as const, time: { created: 9000 } }, parts: [{ type: "text", text: "bg result", synthetic: true }] }
    const u3 = user("third: just a question")
    const a3 = assistant([{ type: "step-start", snapshot: "tree-3" }, { type: "text", text: "answer" }, { type: "step-finish", snapshot: "tree-3" }])
    return { all: [u1, a1, u2, a2, synthetic, u3, a3], u1, u2, u3 }
  }

  test("one checkpoint per typed user turn, newest first, with the snapshot before the agent acted", () => {
    const s = session()
    const cps = listCheckpoints(s.all)
    expect(cps.map((c) => c.messageID)).toEqual([s.u3.info.id, s.u2.info.id, s.u1.info.id])
    expect(cps.map((c) => c.snapshot)).toEqual(["tree-3", "tree-2", "tree-1"])
    expect(cps[1]!.preview).toBe("second: edit b")
    expect(cps[2]!.files.toSorted()).toEqual(["/p/a.ts", "/p/b.ts"])
    expect(cps[0]!.files).toEqual([])
    expect(cps.map((c) => c.turns)).toEqual([1, 2, 3])
  })

  test("capped at 100 by default (newest kept)", () => {
    const many = Array.from({ length: 130 }, (_, i) => [user(`turn ${i}`), assistant([{ type: "step-start", snapshot: `t${i}` }])]).flat()
    const cps = listCheckpoints(many)
    expect(MAX_CHECKPOINTS).toBe(100)
    expect(cps).toHaveLength(100)
    expect(cps[0]!.preview).toBe("turn 129")
    expect(listCheckpoints(many, 3)).toHaveLength(3)
  })

  test("no snapshot when snapshots are off", () => {
    expect(listCheckpoints([user("hi"), assistant([{ type: "text", text: "yo" }])])[0]!.snapshot).toBeUndefined()
  })

  test("last agent snapshot is the newest step-finish", () => {
    expect(lastAgentSnapshot(session().all)).toBe("tree-3")
    expect(lastAgentSnapshot([user("x")])).toBeUndefined()
  })

  test("files changed outside the agent are left alone", () => {
    const plan = planFileRestore({ agentFiles: ["/p/a.ts", "/p/b.ts", "/p/a.ts"], changedOutside: ["/p/b.ts", "/p/c.ts"] })
    expect(plan).toEqual({ restore: ["/p/a.ts"], skipped: ["/p/b.ts"] })
    expect(planFileRestore({ agentFiles: ["C:\\p\\a.ts"], changedOutside: ["C:/p/a.ts"] }).skipped).toEqual(["C:/p/a.ts"])
  })

  test("summary digest is bounded and starts at the chosen turn", () => {
    const s = session()
    const d = summaryDigest(s.all, s.u2.info.id)
    expect(d.startsWith("User: second")).toBe(true)
    expect(d).not.toContain("first: add a file")
    expect(d).toContain("Files changed: /p/b.ts, /p/a.ts")
    expect(d).not.toContain("bg result")
    const long = [user("x".repeat(5000)), ...Array.from({ length: 40 }, () => assistant([{ type: "text", text: "y".repeat(1900) }]))]
    expect(summaryDigest(long, long[0]!.info.id, 4000).length).toBeLessThan(4100)
    expect(summaryDigest(s.all, "missing")).toBe("")
  })

  test("summary message text in EN and ID", () => {
    expect(summaryMessage(" did X ", 2)).toBe("Summary of 2 earlier turns replaced with /rewind:\n\ndid X")
    expect(summaryMessage("x", 1, "id")).toStartWith("Ringkasan 1 giliran")
    expect(isRewindMode("summarize")).toBe(true)
    expect(isRewindMode("nuke")).toBe(false)
  })

  test("disk usage of a tree", async () => {
    fs.mkdirSync(path.join(dir, "a/b"), { recursive: true })
    fs.writeFileSync(path.join(dir, "a/b/f"), "12345")
    fs.writeFileSync(path.join(dir, "g"), "123")
    expect(await diskUsage(dir)).toBe(8)
    expect(await diskUsage(path.join(dir, "missing"))).toBe(0)
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB")
  })
})

describe("U3 plan approval", () => {
  const plan = "# Plan\n\n1. Add **parser** in `src/a.ts`\n2. Wire it in [main](src/main.ts)\n3. Run tests\n\n```\n1. not a step\n```"

  test("pending plan = finished plan-agent reply with text and nothing after it", () => {
    const msgs = [user("plan it"), assistant([{ type: "text", text: plan }], { agent: "plan" })]
    expect(pendingPlan(msgs)).toEqual({ messageID: msgs[1]!.info.id, text: plan })
    expect(pendingPlan([...msgs, user("go")])).toBeUndefined()
    expect(pendingPlan([user("x"), assistant([{ type: "text", text: plan }], { agent: "build" })])).toBeUndefined()
    expect(pendingPlan([user("x"), assistant([{ type: "text", text: plan }], { agent: "plan", finish: "tool-calls" })])).toBeUndefined()
    expect(pendingPlan([user("x"), assistant([{ type: "text", text: plan }], { agent: "plan", error: { name: "x" } })])).toBeUndefined()
    expect(pendingPlan([user("x"), assistant([{ type: "text", text: plan }], { agent: "plan", time: { created: 1 } })])).toBeUndefined()
  })

  test("todos come from the numbered steps (code blocks ignored, markdown cleaned)", () => {
    expect(planTodos(plan)).toEqual([
      { content: "Add parser in src/a.ts", status: "pending", priority: "medium" },
      { content: "Wire it in main", status: "pending", priority: "medium" },
      { content: "Run tests", status: "pending", priority: "medium" },
    ])
    expect(planTodos("- [ ] one\n- [x] two").map((t) => t.content)).toEqual(["one", "two"])
    expect(planTodos("Intro\n- a\n- b\n  - nested").map((t) => t.content)).toEqual(["a", "b"])
    expect(planTodos("just prose")).toEqual([])
    expect(planTodos(Array.from({ length: 30 }, (_, i) => `${i + 1}. step ${i}`).join("\n"))).toHaveLength(20)
  })

  test("instruction and reminder carry the plan, bounded", () => {
    expect(approvalInstruction(plan, "auto")).toContain("run without asking")
    expect(approvalInstruction(plan, "ask")).toContain("asks first")
    expect(approvalInstruction(plan, "ask")).toContain("<plan>\n# Plan")
    expect(planReminder("x".repeat(20_000)).length).toBeLessThan(8_500)
    expect(approvalText("auto", "id")).toBe("Rencana disetujui. Jalankan (Edit otomatis).")
    expect(approvalText("ask")).toContain("asking at each step")
  })

  test("reminder only after a compaction dropped the approval message", () => {
    const approval = user("Plan approved")
    const approved = { messageID: approval.info.id, plan, mode: "auto" as const, at: 1 }
    const compacted = [user("", [{ type: "compaction", auto: true }]), assistant([{ type: "text", text: "summary" }], { summary: true }), user("next")]
    expect(needsPlanReminder(compacted, approved)).toBe(true)
    expect(needsPlanReminder([...compacted, approval], approved)).toBe(false)
    expect(needsPlanReminder([user("no compaction")], approved)).toBe(false)
    expect(needsPlanReminder(compacted, undefined)).toBe(false)
  })

  test("plan store keeps plan.md per session", () => {
    const store = new PlanStore(dir)
    expect(store.get("ses_1")).toBeUndefined()
    store.save("ses_1", { plan, messageID: "msg_1", mode: "ask", at: 5 })
    expect(fs.readFileSync(path.join(dir, "ses_1", "plan.md"), "utf8")).toBe(plan + "\n")
    expect(new PlanStore(dir).get("ses_1")).toEqual({ messageID: "msg_1", plan: plan + "\n", mode: "ask", at: 5 })
    store.clear("ses_1")
    expect(store.get("ses_1")).toBeUndefined()
    expect(() => store.save("../evil", { plan, messageID: "m", mode: "ask" })).toThrow()
  })
})

describe("E3 subagents", () => {
  test("task stays hidden for short turns and appears after 3 reads in one turn (sticky)", () => {
    const short = [user("hi"), assistant([tool("read"), tool("grep")]), user("next"), assistant([tool("glob")])]
    expect(shouldExposeTask(short)).toBe(false)
    const busy = [user("find it"), assistant([tool("read"), tool("grep")]), assistant([tool("glob")])]
    expect(shouldExposeTask(busy)).toBe(true)
    expect(shouldExposeTask([...busy, user("thanks"), assistant([{ type: "text", text: "np" }])])).toBe(true)
    expect(shouldExposeTask([user("x"), assistant([tool("bash"), tool("edit"), tool("write")])])).toBe(false)
    expect(shouldExposeTask(busy, 4)).toBe(false)
  })

  test("@agent mention or prior task use exposes task", () => {
    expect(shouldExposeTask([user("look", [{ type: "agent", name: "explore" }])])).toBe(true)
    expect(shouldExposeTask([user("x"), assistant([tool("task")])])).toBe(true)
  })

  test("explore runs on the cheapest light model of THIS key; plan on the heavy chain", () => {
    const allowed = allowedFrom(["deepseek-v4-pro-0813", "deepseek-v4.1-flash", "minimax-m3.1-flash", "default-model"])
    expect(subagentModel({ tier: "light", policy: DEFAULT_POLICY, allowed })).toBe("deepseek-v4.1-flash")
    const prices: Record<string, number> = { "deepseek-v4.1-flash": 0.3, "minimax-m3.1-flash": 0.2 }
    expect(subagentModel({ tier: "light", policy: DEFAULT_POLICY, allowed, price: (id) => prices[id] })).toBe("minimax-m3.1-flash")
    expect(subagentModel({ tier: "heavy", policy: DEFAULT_POLICY, allowed })).toBe("deepseek-v4-pro-0813")
  })

  test("Flash-only and Luna-only keys still get a light model; no models = keep the parent's", () => {
    expect(subagentModel({ tier: "light", policy: DEFAULT_POLICY, allowed: allowedFrom(["glm-5.3-flash"]) })).toBe("glm-5.3-flash")
    expect(subagentModel({ tier: "light", policy: DEFAULT_POLICY, allowed: allowedFrom(["gpt-6-luna", "default-model"]) })).toBe("gpt-6-luna")
    expect(subagentModel({ tier: "heavy", policy: DEFAULT_POLICY, allowed: allowedFrom(["gpt-6-luna", "default-model"]) })).toBe("default-model")
    expect(subagentModel({ tier: "light", policy: DEFAULT_POLICY, allowed: allowedFrom([]) })).toBeUndefined()
  })

  test("model words", () => {
    expect(modelSpec("haiku")).toEqual({ tier: "light" })
    expect(modelSpec("Heavy")).toEqual({ tier: "heavy" })
    expect(modelSpec("inherit")).toEqual({})
    expect(modelSpec("glm-5.3-flash")).toEqual({ model: "glm-5.3-flash" })
    expect(modelSpec(undefined)).toEqual({})
  })

  test("Claude agent file: read-only by default; listed tools allowed, shell/edits ask; maxTurns and model mapped", () => {
    const ro = fromClaudeAgent({ name: "finder", description: "Finds things" }, "  You find. ", "ezkielyna")
    expect(ro.permission).toEqual({ "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow", lsp: "allow" })
    expect(ro.prompt).toBe("You find.")
    expect(ro.mode).toBe("subagent")
    const rw = fromClaudeAgent({ tools: "Read, Grep, Bash, Edit", model: "sonnet", maxTurns: 6 }, "x", "ezkielyna")
    expect(rw.permission).toEqual({ "*": "deny", read: "allow", grep: "allow", bash: "ask", edit: "ask" })
    expect(rw.steps).toBe(6)
    expect(rw.options).toEqual({ ezkTier: "heavy", ezkSource: "claude" })
    const auto = fromClaudeAgent({ tools: ["Read", "Write"], permissionMode: "acceptEdits", model: "glm-5.3-flash" }, "x", "ezkielyna")
    expect(auto.permission!.edit).toBe("allow")
    expect(auto.model).toBe("ezkielyna/glm-5.3-flash")
    // permissionMode never adds a tool the file did not list
    expect(fromClaudeAgent({ permissionMode: "bypassPermissions" }, "x", "e").permission!.edit).toBeUndefined()
    expect(fromClaudeAgent({ tools: "Read, Bash", permissionMode: "plan" }, "x", "e").permission!.bash).toBe("deny")
  })

  test("our agent files: light/heavy model, maxTurns, permissionMode", () => {
    const a = normalizeAgent({ model: "light", options: { maxTurns: 3, permissionMode: "plan" }, permission: { read: "allow" } })
    expect(a.model).toBeUndefined()
    expect(a.options!.ezkTier).toBe("light")
    expect(a.steps).toBe(3)
    expect(a.permission).toEqual({ read: "allow", edit: "deny", bash: "deny", webfetch: "deny" })
    expect(normalizeAgent({ model: "ezkielyna/x", steps: 9, options: { maxTurns: 2 } })).toMatchObject({ model: "ezkielyna/x", steps: 9 })
    expect(permissionOverlay("full")).toEqual({ edit: "allow" })
  })

  test("results are capped at about 2k tokens, head and tail kept", () => {
    expect(capResult("short", 2000)).toBe("short")
    const text = "H".repeat(6000) + "M".repeat(6000) + "T".repeat(6000)
    const out = capResult(text, 2000)
    expect(out.length).toBeLessThanOrEqual(8000)
    expect(out.startsWith("HHH")).toBe(true)
    expect(out.endsWith("TTT")).toBe(true)
    expect(out).toContain("characters cut")
  })

  test("explore prompt asks for path:start-end lines within the turn budget", () => {
    const p = explorePrompt(4)
    expect(p).toContain("at most 4 turns")
    expect(p).toContain("path/to/file.ts:12-40")
    expect(p).toContain("in parallel")
  })
})

describe("C4 handoff", () => {
  const msgs = [
    user("fix the login bug"),
    assistant([tool("read", { filePath: "/p/src/auth.ts" }), tool("read", { filePath: "/etc/hosts" }), tool("edit", { filePath: "/p/src/login.ts" })]),
    assistant([{ type: "patch", files: ["/p/src/login.ts", "/p/test/login.test.ts"] }, { type: "text", text: "Fixed; tests pass." }]),
    assistant([tool("bash", { command: "bun test" }, "error")]),
  ]
  test("files: changed first, then read, project-relative, outside paths dropped", () => {
    expect(handoffFiles(msgs, "/p")).toEqual(["src/login.ts", "test/login.test.ts", "src/auth.ts"])
    expect(handoffFiles(msgs, "/p", 1)).toEqual(["src/login.ts"])
  })
  test("digest, request and prefilled prompt", () => {
    const d = handoffDigest(msgs)
    expect(d).toContain("User: fix the login bug")
    expect(d).toContain("Assistant: Fixed; tests pass.")
    expect(d).toContain("Tool bash failed")
    expect(handoffDigest(Array.from({ length: 50 }, () => user("z".repeat(1000))), 2000).length).toBeLessThan(2100)
    expect(handoffRequest("add 2FA", d, ["src/a.ts"])).toContain("Relevant files: src/a.ts")
    expect(handoffPrompt("Continue the 2FA work.", "add 2FA", ["src/a.ts", "b.ts"])).toBe("Continue the 2FA work.\n\nRelevant files: @src/a.ts @b.ts")
    expect(handoffPrompt("  ", "add 2FA", [])).toBe("Goal: add 2FA")
  })
})
