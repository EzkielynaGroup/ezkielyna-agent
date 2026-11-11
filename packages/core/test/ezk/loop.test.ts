import { describe, expect, test } from "bun:test"
import { DEFAULT_FLAGS, loadFlags } from "../../src/ezk/flags"
import { normalizeModelHistory } from "../../src/ezk/loop/history"
import { explicitlySkipsVerify, LoopPolicy, phaseFor, questionOnly, reasoningEffort, supportedVariant } from "../../src/ezk/loop/policy"

describe("loop feature flags", () => {
  test("loop changes are opt-in and can be selected independently", () => {
    expect(DEFAULT_FLAGS.loop).toEqual({
      leadWorker: false,
      phaseReasoning: false,
      verificationGate: false,
      verify: false,
      plan: false,
      guard: false,
      resilience: false,
      history: false,
      hard: false,
    })
    const flags = loadFlags([], { EZK_FEATURES: "+loop.lead-worker,+loop.phase-reasoning,+loop.verify,+loop.plan,+loop.hard,-loop.guard" })
    expect(flags.loop).toMatchObject({ leadWorker: true, phaseReasoning: true, guard: false })
    expect(flags.loop).toMatchObject({ verify: true, plan: true, hard: true })
    expect(flags.loop.verificationGate).toBe(false)
  })
})

describe("loop routing and guards", () => {
  test("lead turns are heavy until a plan exists; explicit tier controls win", () => {
    const loop = new LoopPolicy()
    expect(loop.beginTurn("s", { messageID: "m1", prompt: "implement the feature" })).toMatchObject({ tier: "heavy" })
    loop.planReady("s")
    expect(loop.beginTurn("s", { messageID: "m2", prompt: "implement the plan" })).toMatchObject({
      tier: "light",
      reason: "execution phase after plan or todo",
    })
    expect(loop.beginTurn("s", { messageID: "m3", prompt: "@heavy finish", forced: "heavy" })).toMatchObject({
      tier: "heavy",
      reason: "forced by @heavy",
    })
    expect(loop.beginTurn("s", { messageID: "m4", prompt: "@light finish", forced: "light" })).toMatchObject({
      tier: "light",
      reason: "forced by @light",
    })
  })

  test("a plan artifact ends lead routing only after its tool call succeeds", () => {
    const loop = new LoopPolicy()
    loop.beginTurn("s", { messageID: "m1", prompt: "make a plan" })
    loop.recordCall("s", "plan-call", "write", { filePath: ".ezkielyna/plans/task.md" })
    loop.recordOutcome("s", "plan-call", { failed: true })
    expect(loop.beginTurn("s", { messageID: "m2", prompt: "implement the plan" }).tier).toBe("heavy")

    loop.recordCall("s", "plan-call-2", "write", { filePath: ".ezkielyna/plans/task.md" })
    loop.recordOutcome("s", "plan-call-2", { failed: false })
    expect(loop.beginTurn("s", { messageID: "m3", prompt: "implement the plan" })).toMatchObject({
      tier: "light",
      reason: "execution phase after plan or todo",
    })
  })

  test("two consecutive failures reserve the next two turns for heavy", () => {
    const loop = new LoopPolicy()
    loop.beginTurn("s", { messageID: "m1", prompt: "first" })
    loop.planReady("s")
    loop.recordCall("s", "c1", "edit", { filePath: "a.ts" })
    loop.recordCall("s", "c2", "bash", { command: "bun test a.test.ts" })
    loop.recordOutcome("s", "c1", { failed: true })
    loop.recordOutcome("s", "c2", { failed: true })
    expect(loop.beginTurn("s", { messageID: "m2", prompt: "continue" })).toMatchObject({
      tier: "heavy",
      reason: "heavy after two consecutive tool failures",
      phase: "implementation",
    })
    expect(loop.beginTurn("s", { messageID: "m3", prompt: "continue" }).tier).toBe("heavy")
    expect(loop.beginTurn("s", { messageID: "m4", prompt: "continue" })).toMatchObject({ tier: "light" })
  })

  test("per-file edits remind once and repeated tool windows ask for user direction", () => {
    const loop = new LoopPolicy()
    loop.beginTurn("s", { messageID: "m1", prompt: "change a file" })
    for (let i = 1; i <= 5; i++) loop.recordCall("s", `edit-${i}`, "edit", { filePath: "src/a.ts", content: String(i) })
    expect(loop.takeReminder("s")?.text).toBe("Step back: re-read the error and consider another approach.")
    loop.recordCall("s", "edit-6", "edit", { filePath: "src/a.ts", content: "six" })
    expect(loop.takeReminder("s")).toBeUndefined()

    const repeated = new LoopPolicy()
    repeated.beginTurn("s", { messageID: "m1", prompt: "debug" })
    for (let i = 0; i < 6; i++) repeated.recordCall("s", `a${i}`, i % 2 ? "read" : "bash", { path: "same" })
    expect(repeated.takeReminder("s")?.askUser).toBe(false)
    for (let i = 6; i < 12; i++) repeated.recordCall("s", `a${i}`, i % 2 ? "read" : "bash", { path: "same" })
    expect(repeated.takeReminder("s")).toMatchObject({ askUser: true })
  })

  test("phase reasoning uses high for plan and verification, medium for implementation", () => {
    const planning = phaseFor({ prompt: "make a plan for the migration" })
    expect(planning).toBe("plan")
    expect(phaseFor({ prompt: "verify the plan and run tests" })).toBe("verify")
    expect(phaseFor({ prompt: "continue", messages: [{ info: { role: "assistant" }, parts: [
      { type: "tool", tool: "bash", state: { input: { command: "bun test packages/core" } } },
    ] }] })).toBe("verify")
    const implementation = phaseFor({ prompt: "rename a local variable" })
    expect(implementation).toBe("implementation")
    expect(reasoningEffort(planning)).toBe("high")
    expect(reasoningEffort("verify")).toBe("high")
    expect(reasoningEffort(implementation)).toBe("medium")
    expect(supportedVariant("high", { high: { reasoningEffort: "high" } })).toBe("high")
    expect(supportedVariant("medium", undefined)).toBeUndefined()
  })

  test("verification gate is limited to one reminder after edits", () => {
    const loop = new LoopPolicy()
    loop.beginTurn("s", { messageID: "m1", prompt: "change a file" })
    loop.recordCall("s", "edit", "edit", { filePath: "src/a.ts" })
    expect(loop.hasEdits("s", "m1")).toBe(true)
    expect(loop.claimVerification("s", "m1")).toBe(true)
    expect(loop.claimVerification("s", "m1")).toBe(false)
    expect(loop.claimVerification("s", "other-task")).toBe(false)
  })

  test("verify-fix loop passes, retries with a 60-line failure reminder, and stops after three failures", () => {
    const loop = new LoopPolicy()
    loop.beginTurn("verify", { messageID: "m1", prompt: "fix this code", verifyCommand: "bun run typecheck" })
    loop.recordCall("verify", "edit", "write", { filePath: "src/a.ts" })
    expect(loop.claimVerify("verify", "m1")).toEqual({ command: "bun run typecheck", attempt: 1 })
    expect(loop.beginVerify("verify", "verify-1", "bun run typecheck")).toBe(true)
    const output = Array.from({ length: 75 }, (_, index) => `line ${index + 1}`).join("\n")
    expect(loop.finishVerify("verify", "verify-1", { exit: 1, output })).toBe(true)
    const failed = loop.takeReminder("verify")!.text
    expect(failed).toContain("round 1/3")
    expect(failed).toContain("line 16")
    expect(failed).toContain("line 75")
    expect(failed).not.toContain("line 15")

    expect(loop.claimVerify("verify", "m1")).toEqual({ command: "bun run typecheck", attempt: 2 })
    expect(loop.beginVerify("verify", "verify-2", "bun run typecheck")).toBe(true)
    loop.finishVerify("verify", "verify-2", { exit: 1, output: "second failure" })
    expect(loop.takeReminder("verify")?.text).toContain("round 2/3")
    expect(loop.claimVerify("verify", "m1")).toEqual({ command: "bun run typecheck", attempt: 3 })
    expect(loop.beginVerify("verify", "verify-3", "bun run typecheck")).toBe(true)
    expect(loop.finishVerify("verify", "verify-3", { exit: 1, output: "third failure" })).toBe(true)
    expect(loop.takeReminder("verify")?.text).toContain("masih gagal setelah 3 percobaan")
    expect(loop.claimVerify("verify", "m1")).toBeUndefined()
  })

  test("forced plans use todowrite and request a reread when the phase changes", () => {
    const loop = new LoopPolicy()
    expect(loop.beginTurn("plan", { messageID: "m1", prompt: "Refactor the service", forcePlan: true, updatePlan: true })).toMatchObject({
      tier: "heavy",
      reason: "heavy task requires a plan first",
    })
    expect(loop.takeReminder("plan")?.text).toContain("todowrite")
    loop.recordCall("plan", "todos", "todowrite", { todos: [{ content: "change service", status: "pending" }] })
    loop.recordOutcome("plan", "todos", { failed: false })
    expect(loop.takeReminder("plan")?.text).toContain("plan is now active")

    loop.beginTurn("plan", { messageID: "m2", prompt: "run tests", updatePlan: true })
    expect(loop.takeReminder("plan")?.text).toContain("phase change")
  })

  test("verification skips explicit no-test requests and keeps successful verification final", () => {
    expect(explicitlySkipsVerify("jangan jalankan test")).toBe(true)
    expect(explicitlySkipsVerify("do not run tests")).toBe(true)
    expect(explicitlySkipsVerify("please fix the failing tests")).toBe(false)
    expect(questionOnly("How do I fix this?")).toBe(true)
    expect(questionOnly("Can you fix this?")).toBe(false)

    const loop = new LoopPolicy()
    loop.beginTurn("pass", { messageID: "m1", prompt: "fix this file", verifyCommand: "npm run typecheck" })
    loop.recordCall("pass", "edit", "write", { filePath: "src/a.ts" })
    expect(loop.claimVerify("pass", "m1")).toBeDefined()
    expect(loop.beginVerify("pass", "v1", "npm run typecheck")).toBe(true)
    expect(loop.finishVerify("pass", "v1", { exit: 0, output: "ok" })).toBe(false)
    expect(loop.claimVerify("pass", "m1")).toBeUndefined()

    const question = new LoopPolicy()
    question.beginTurn("question", { messageID: "q1", prompt: "What does this helper do?", verifyCommand: "npm run typecheck" })
    expect(question.claimVerify("question", "q1")).toBeUndefined()
  })
})

describe("loop history normalizer", () => {
  test("inserts interrupted results for orphan calls and drops unmatched results", () => {
    const messages = normalizeModelHistory([
      { role: "tool", content: [{ type: "tool-result", toolCallId: "orphan", output: { type: "text", value: "ignored" } }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "edit", input: {} }] },
      { role: "user", content: "next" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-2", toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-2", toolName: "read", output: { type: "text", value: "done" } }] },
    ], "[aborted]")

    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "user", "assistant", "tool"])
    expect(messages[1]?.content).toMatchObject([{ toolCallId: "call-1", output: { type: "text", value: "[aborted]" } }])
    expect(messages[4]?.content).toMatchObject([{ toolCallId: "call-2", output: { type: "text", value: "done" } }])
  })

  test("leaves already paired calls unchanged", () => {
    const input = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "read", output: { type: "text", value: "ok" } }] },
    ]
    expect(normalizeModelHistory(input, "[aborted]")).toEqual(input)
  })
})
