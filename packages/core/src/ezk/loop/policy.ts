import { createHash } from "node:crypto"
import { classifyIntent } from "../intent/classify"

export type Phase = "plan" | "verify" | "implementation"
export type Tier = "heavy" | "light"

export interface LoopMessage {
  info?: { role?: string; agent?: string }
  parts?: Array<{ type?: string; tool?: string; state?: { input?: unknown }; text?: string }>
}

export interface LoopTurnInput {
  messageID: string
  prompt: string
  planMode?: boolean
  forced?: Tier
  forcePlan?: boolean
  planApproval?: boolean
  updatePlan?: boolean
  verifyCommand?: string
  skipVerify?: boolean
}

export interface LoopTurnDecision {
  tier?: Tier
  reason?: string
  phase: Phase
}

export interface LoopReminder {
  text: string
  askUser: boolean
}

const MAX_SESSIONS = 500
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch"])
const VERIFY_COMMAND = /\b(test|tests|spec|lint|typecheck|type-check|verify|check|build)\b/i
const PLAN_PROMPT = /\b(plan|planning|design|architect(?:ure)?)\b/i
const VERIFY_PROMPT = /\b(verify|verification|run tests|test results|typecheck|lint|check failures)\b/i

interface TaskState {
  id: string
  edits: Map<string, number>
  editReminderSent: Set<string>
  calls: string[]
  repeatAlerts: Map<string, { count: number; lastEnd: number; length: number }>
  loopReminderSent: boolean
  verificationSent: boolean
  reminders: LoopReminder[]
  planRequested: boolean
  verify: {
    command?: string
    skipped: boolean
    explicitSkip: boolean
    prompts: number
    failures: number
    pending: boolean
    passed: boolean
    stopped: boolean
    calls: Set<string>
  }
}

interface SessionState {
  turns: number
  planReady: boolean
  consecutiveFailures: number
  heavyTurns: number
  task: TaskState
  seenCalls: Set<string>
  callOrder: string[]
  failedCalls: Set<string>
  planCalls: Set<string>
  phase?: Phase
}

function task(id: string): TaskState {
  return {
    id,
    edits: new Map(),
    editReminderSent: new Set(),
    calls: [],
    repeatAlerts: new Map(),
    loopReminderSent: false,
    verificationSent: false,
    reminders: [],
    planRequested: false,
    verify: {
      skipped: false,
      explicitSkip: false,
      prompts: 0,
      failures: 0,
      pending: false,
      passed: false,
      stopped: false,
      calls: new Set(),
    },
  }
}

function normalizeFile(value: unknown) {
  if (typeof value !== "string") return ""
  return value.replaceAll("\\", "/").trim()
}

function isPlanArtifact(tool: string, args: unknown) {
  if (/^(todo|plan|update_plan|todowrite)$/i.test(tool)) return true
  if (!EDIT_TOOLS.has(tool.toLowerCase())) return false
  const input = args && typeof args === "object" ? args as Record<string, unknown> : undefined
  const file = normalizeFile(input?.filePath ?? input?.path)
  return /(?:^|\/)(?:\.ezkielyna\/plans\/|[^/]*plan[^/]*\.md$)/i.test(file)
}

export function phaseFor(input: {
  prompt: string
  planMode?: boolean
  messages?: LoopMessage[]
}): Phase {
  if (VERIFY_PROMPT.test(input.prompt)) return "verify"
  if (input.planMode || PLAN_PROMPT.test(input.prompt)) return "plan"
  for (const message of [...(input.messages ?? [])].reverse()) {
    if (message.info?.role !== "assistant") continue
    for (const part of [...(message.parts ?? [])].reverse()) {
      if (part.type !== "tool" || !["bash", "shell"].includes((part.tool ?? "").toLowerCase())) continue
      const args = part.state?.input as Record<string, unknown> | undefined
      if (VERIFY_COMMAND.test(String(args?.command ?? ""))) return "verify"
    }
  }
  return "implementation"
}

export function reasoningEffort(phase: Phase) {
  return phase === "implementation" ? "medium" : "high"
}

export function explicitlySkipsVerify(prompt: string) {
  return /\b(?:don't|dont|do not|skip|avoid)\s+(?:run\s+|running\s+)?(?:the\s+)?(?:tests?|test suite|verification|checks?)\b|\b(?:jangan|tak perlu)\s+(?:jalankan\s+|menjalankan\s+)?(?:test|tes|verifikasi|pemeriksaan)\b/i.test(prompt)
}

export function questionOnly(prompt: string) {
  return classifyIntent(prompt) === "qa"
}

export function supportedVariant(requested: string | undefined, variants?: Record<string, unknown>) {
  return requested && variants && Object.prototype.hasOwnProperty.call(variants, requested) ? requested : undefined
}

/** Bounded, in-memory state for the opt-in session lead/worker and loop guards. */
export class LoopPolicy {
  private sessions = new Map<string, SessionState>()

  private state(sessionID: string, messageID = "") {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = {
        turns: 0,
        planReady: false,
        consecutiveFailures: 0,
        heavyTurns: 0,
        task: task(messageID),
        seenCalls: new Set(),
        callOrder: [],
        failedCalls: new Set(),
        planCalls: new Set(),
      }
      this.sessions.set(sessionID, state)
      if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
    }
    return state
  }

  beginTurn(sessionID: string, input: LoopTurnInput): LoopTurnDecision {
    const state = this.state(sessionID, input.messageID)
    if (state.task.id !== input.messageID) {
      state.task = task(input.messageID)
      state.seenCalls.clear()
      state.callOrder = []
      state.planCalls.clear()
      state.turns += 1
    } else if (state.turns === 0) {
      state.turns = 1
    }

    const phase = phaseFor({ prompt: input.prompt, planMode: input.planMode })
    state.task.verify.command = input.verifyCommand
    state.task.verify.skipped = input.skipVerify === true || !input.verifyCommand
    state.task.verify.explicitSkip = input.skipVerify === true
    if (input.forcePlan && !state.task.planRequested) {
      state.task.planRequested = true
      state.task.reminders.push({
        text: input.planApproval
          ? "Draft a short numbered plan in plan mode, then stop and wait for the plan approval card. Do not edit files or run commands before approval."
          : "Before editing or running commands, create a short numbered plan with todowrite. Keep it updated as work progresses and re-read it when the phase changes.",
        askUser: false,
      })
    } else if (input.updatePlan && state.planReady && state.phase && state.phase !== phase) {
      state.task.reminders.push({
        text: "Re-read the current todo plan at this phase change, update each step's status with todowrite, and continue only with the next pending step.",
        askUser: false,
      })
    }
    state.phase = phase
    if (input.forced) return { tier: input.forced, reason: `forced by @${input.forced}`, phase }
    if (input.forcePlan) return { tier: "heavy", reason: "heavy task requires a plan first", phase }
    if (state.heavyTurns > 0) {
      state.heavyTurns -= 1
      return { tier: "heavy", reason: "heavy after two consecutive tool failures", phase }
    }
    if (state.planReady) return { tier: "light", reason: "execution phase after plan or todo", phase }
    if (state.turns <= 3) return { tier: "heavy", reason: `lead planning turn ${state.turns}/3`, phase }
    return { phase }
  }

  planReady(sessionID: string) {
    this.state(sessionID).planReady = true
  }

  phaseChanged(sessionID: string, phase: Phase) {
    const state = this.state(sessionID)
    if (state.planReady && state.phase && state.phase !== phase) {
      state.task.reminders.push({
        text: "Re-read the current todo plan at this phase change, update each step's status with todowrite, and continue only with the next pending step.",
        askUser: false,
      })
    }
    state.phase = phase
  }

  /** Claim one bounded project-verification reminder after an edit or a failed verify attempt. */
  claimVerify(sessionID: string, taskID: string) {
    const current = this.sessions.get(sessionID)?.task
    if (!current || current.id !== taskID || current.verify.skipped || current.verify.passed || current.verify.stopped) return
    if (!current.edits.size && !current.verify.failures) return
    if (current.verify.pending) current.verify.pending = false
    if (current.verify.prompts >= 3) {
      current.verify.stopped = true
      current.reminders.push({
        text: `masih gagal setelah 3 percobaan: jalankan ${current.verify.command} bila perlu, lalu laporkan kegagalan dan bukti yang tersedia secara jujur. Jangan mengklaim verifikasi berhasil.`,
        askUser: false,
      })
      return
    }
    current.verify.pending = true
    current.verify.prompts++
    current.verificationSent = true
    return { command: current.verify.command!, attempt: current.verify.prompts }
  }

  verifySkipped(sessionID: string, taskID: string) {
    const current = this.sessions.get(sessionID)?.task
    return !current || current.id !== taskID || current.verify.explicitSkip
  }

  /** Recognize the exact detected command while retaining the normal shell permission flow. */
  beginVerify(sessionID: string, callID: string, command: string) {
    const verify = this.sessions.get(sessionID)?.task.verify
    if (!verify?.command || command.trim() !== verify.command || verify.skipped || verify.stopped) return false
    verify.pending = false
    verify.calls.add(callID)
    return true
  }

  finishVerify(sessionID: string, callID: string, input: { exit?: number; output?: string }) {
    const current = this.sessions.get(sessionID)?.task
    if (!current?.verify.calls.delete(callID)) return
    if (input.exit === 0) {
      current.verify.passed = true
      current.verificationSent = true
      return false
    }
    current.verify.failures++
    const tail = (input.output ?? "").split(/\r?\n/).slice(-60).join("\n").trim()
    if (current.verify.failures >= 3) {
      current.verify.stopped = true
      current.reminders.push({
        text: `masih gagal setelah 3 percobaan: ${current.verify.command}\n${tail || `verify command exited with ${input.exit ?? "an unknown status"}` }\nBerhenti mengubah kode dan laporkan hasil ini dengan jujur.`,
        askUser: false,
      })
      return true
    }
    current.reminders.push({
      text: `Project verification failed (round ${current.verify.failures}/3). Fix the cause, then run the same verify command again. Last output (up to 60 lines):\n${tail || `verify command exited with ${input.exit ?? "an unknown status"}`}`,
      askUser: false,
    })
    return true
  }

  /** Track edits before execution so failed edits count toward the per-file guard too. */
  recordCall(sessionID: string, callID: string, tool: string, args: unknown) {
    const state = this.state(sessionID)
    if (state.seenCalls.has(callID)) return
    state.seenCalls.add(callID)
    state.callOrder.push(callID)
    if (state.callOrder.length > 1000) {
      const oldest = state.callOrder.shift()!
      state.seenCalls.delete(oldest)
      state.planCalls.delete(oldest)
    }

    const name = tool.toLowerCase()
    const input = args as Record<string, unknown> | undefined
    if (isPlanArtifact(name, input)) state.planCalls.add(callID)
    if (EDIT_TOOLS.has(name)) {
      const file = normalizeFile(input?.filePath ?? input?.path)
      if (file) {
        const count = (state.task.edits.get(file) ?? 0) + 1
        state.task.edits.set(file, count)
        if (count >= 5 && !state.task.editReminderSent.has(file)) {
          state.task.editReminderSent.add(file)
          state.task.reminders.push({
            text: "Step back: re-read the error and consider another approach.",
            askUser: false,
          })
        }
      }
    }

    const signature = createHash("sha256").update(JSON.stringify([name, input ?? null])).digest("hex")
    state.task.calls.push(signature)
    if (state.task.calls.length > 15) state.task.calls.shift()
    const repeated = repeatedWindow(state.task.calls)
    if (!repeated) return
    const previous = state.task.repeatAlerts.get(repeated.key)
    const count = !previous ? 1 : repeated.end - previous.lastEnd >= repeated.length * 3 ? previous.count + 1 : previous.count
    if (!previous || count > previous.count) {
      state.task.repeatAlerts.set(repeated.key, { count, lastEnd: repeated.end, length: repeated.length })
      if (count === 1 && !state.task.loopReminderSent) {
        state.task.loopReminderSent = true
        state.task.reminders.push({
          text: "Step back: re-read the error and consider another approach.",
          askUser: false,
        })
      } else if (count >= 2) {
        state.task.reminders.push({
          text: "Step back: re-read the error, consider another approach, and ask the user how to proceed.",
          askUser: true,
        })
      }
    }
  }

  recordOutcome(sessionID: string, callID: string, input: { failed: boolean }) {
    const state = this.state(sessionID)
    if (!state.seenCalls.has(callID)) return
    if (!input.failed) {
      if (state.planCalls.delete(callID)) {
        state.planReady = true
        if (state.task.planRequested) {
          state.task.reminders.push({
            text: "The plan is now active. Re-read the current todo list, mark the first step in_progress, and keep todo statuses synchronized as you work.",
            askUser: false,
          })
        }
      }
      state.consecutiveFailures = 0
      return
    }
    state.planCalls.delete(callID)
    if (state.failedCalls.has(callID)) return
    state.failedCalls.add(callID)
    if (state.failedCalls.size > 1000) state.failedCalls.delete(state.failedCalls.values().next().value!)
    state.consecutiveFailures += 1
    if (state.consecutiveFailures >= 2) {
      state.heavyTurns = 2
      state.consecutiveFailures = 0
    }
  }

  takeReminder(sessionID: string) {
    return this.state(sessionID).task.reminders.shift()
  }

  hasEdits(sessionID: string, taskID: string) {
    const current = this.sessions.get(sessionID)?.task
    return current?.id === taskID && current.edits.size > 0
  }

  claimVerification(sessionID: string, taskID: string) {
    const current = this.sessions.get(sessionID)?.task
    if (!current || current.id !== taskID || current.verificationSent || current.edits.size === 0) return false
    current.verificationSent = true
    return true
  }

  forget(sessionID: string) {
    this.sessions.delete(sessionID)
  }
}

function repeatedWindow(calls: string[]) {
  for (let length = 2; length <= 5; length++) {
    if (calls.length < length * 3) continue
    const end = calls.length
    const first = calls.slice(end - length * 3, end - length * 2)
    const second = calls.slice(end - length * 2, end - length)
    const third = calls.slice(end - length)
    if (first.every((value, index) => value === second[index] && value === third[index])) {
      const rotations = first.map((_, index) => [...first.slice(index), ...first.slice(0, index)].join(":"))
      return { key: rotations.sort()[0]!, length, end }
    }
  }
}
