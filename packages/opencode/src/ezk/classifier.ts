// Ezkielyna Agent v3 (S5): opencode side of the "Otomatis-aman" classifier (flag safety.classifier, default OFF).
// Keeps per-session state, the user's own messages (never assistant text or tool output) and the gateway call.
import { costUSD } from "@opencode-ai/core/ezk/pricing"
import { reviewerModelFor } from "@opencode-ai/core/ezk/skills/disclosure"
import { blockedText, classify, gatewayCall, ClassifierState, MAX_USER_CHARS, MAX_USER_MESSAGES, type Call, type Outcome } from "@opencode-ai/core/ezk/safety/classifier"
import { currentMode, flags, projectRoot } from "@/ezk/safety"
import type { Decision } from "@opencode-ai/core/ezk/safety/decide"
import { ezkRuntime } from "@/plugin/ezk/runtime"
import {
  breakerTripped as readBreakerTripped,
  classifierEpoch,
  resetClassifier as resetClassifierState,
  setClassifierTripped,
} from "./classifier-state"

const states = new Map<string, { epoch: number; state: ClassifierState }>()
const users = new Map<string, string[]>()

export const classifierState = (sessionID: string) => {
  const epoch = classifierEpoch(sessionID)
  let item = states.get(sessionID)
  if (!item || item.epoch !== epoch) {
    item = { epoch, state: new ClassifierState() }
    states.set(sessionID, item)
    setClassifierTripped(sessionID, false)
  }
  return item.state
}
export const classifierEnabled = () => flags().safety.classifier

/** chat.message: remember what the USER typed (synthetic reminders and tool output never come through here). */
export function recordUserMessage(sessionID: string, text: string) {
  const t = text.trim()
  if (!t) return
  const list = users.get(sessionID) ?? []
  list.push(t.slice(0, MAX_USER_CHARS))
  while (list.length > MAX_USER_MESSAGES) list.shift()
  users.set(sessionID, list)
  // a new user message starts a new run of blocks (the breaker counts consecutive blocks, not the total)
  classifierState(sessionID).inRow = 0
}
export const userMessages = (sessionID: string) => users.get(sessionID) ?? []

/** Switching mode by hand re-arms the classifier. */
export const resetClassifier = (sessionID: string) => {
  resetClassifierState(sessionID)
  states.delete(sessionID)
}
export const breakerTripped = readBreakerTripped

async function realCall(sessionID: string): Promise<Call> {
  const rt = ezkRuntime()
  await rt.ensureAllowed().catch(() => undefined)
  const key = rt.key()
  const model = reviewerModelFor(rt.engine.allowed.ids, {
    policy: rt.engine.policy,
    price: (m) => {
      const p = rt.prices.get(m)
      return p ? { ...p } : undefined
    },
  })
  if (!key || !model) throw new Error("no classifier model")
  const state = classifierState(sessionID)
  return async ({ system, prompt, signal }) => {
    const out = await gatewayCall({
      baseURL: rt.baseURL,
      key,
      model,
      system,
      prompt,
      signal,
      price: (t) => costUSD(rt.prices.get(model), t),
    })
    // classifier spend counts toward the session cost cap (the router's per-message ledger)
    rt.engine.setMessageCost(sessionID, `classifier:${state.calls}`, out.usd ?? 0)
    return out
  }
}

/** Permission.ask: the answer for one call the normal layers left as "ask". `call` is injectable for tests. */
export async function classifyCall(input: {
  sessionID: string
  permission: string
  pattern: string
  cwd: string
  root: string
  trusted: boolean
  call?: Call
}): Promise<Outcome & { text?: { en: string; id: string } }> {
  const state = classifierState(input.sessionID)
  let call = input.call
  if (!call) {
    try {
      call = await realCall(input.sessionID)
    } catch {
      return { action: "ask", source: "fallback", reason: "classifier unavailable" }
    }
  }
  const rt = input.call ? undefined : ezkRuntime()
  const out = await classify({
    pending: { permission: input.permission, pattern: input.pattern, cwd: input.cwd, root: input.root },
    users: userMessages(input.sessionID),
    trusted: input.trusted,
    state,
    call,
    capped: rt ? rt.engine.capReached(input.sessionID) : false,
  })
  setClassifierTripped(input.sessionID, state.tripped)
  return out.action === "ask" && out.blocked ? { ...out, text: blockedText(out.reason) } : out
}

/**
 * Permission.ask hook, after `layer()`. Only a plain "ask" in an effective safeAuto session reaches the classifier:
 * deny rules, plan, remembered ask rules, untrusted folders and every other mode keep their answer untouched.
 * A block stays an "ask" for the user, with the reason in `metadata` ("Diblokir otomatis: ...", allow once = reply once).
 */
export async function gate(
  input: { sessionID: string; permission: string; pattern: string; directory: string; worktree: string; call?: Call },
  decision: Decision,
): Promise<{ action: Decision["action"]; metadata?: Record<string, unknown> }> {
  if (!classifierEnabled() || decision.action !== "ask" || decision.reason !== "base") return { action: decision.action }
  const mode = currentMode(input.sessionID, input.directory, input.worktree)
  if (mode.effective !== "safeAuto") return { action: decision.action }
  const state = classifierState(input.sessionID)
  const out = await classifyCall({
    sessionID: input.sessionID,
    permission: input.permission,
    pattern: input.pattern,
    cwd: input.worktree,
    root: projectRoot(input.directory, input.worktree),
    trusted: mode.trusted,
    call: input.call,
  })
  const banner = state.banner()
  const metadata: Record<string, unknown> = {}
  if (out.action === "ask" && out.blocked) metadata.ezkAutoBlocked = blockedText(out.reason)
  if (banner) metadata.ezkAutoBanner = banner
  return { action: out.action, metadata: Object.keys(metadata).length ? metadata : undefined }
}
