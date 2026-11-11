// Ezkielyna Agent v3 U3: plan approval. The client shows the card when the plan agent finishes (core pendingPlan);
// approving saves plan.md for the session, creates the todo list from it, sets the permission mode and starts the
// build agent on it. The plan comes back after compaction through the ux plugin (appended reminder, cache-safe).
import { Effect } from "effect"
import { type ApprovalMode, approvalInstruction, approvalText, pendingPlan, planTodos } from "@opencode-ai/core/ezk/ux/plan"
import { planStore } from "./plan-store"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { projectTrusted } from "@/config/trust"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { Todo } from "@/session/todo"
import { MessageID, SessionID } from "@/session/schema"

export { planStore } from "./plan-store"

/** "Edit otomatis" for this session: edits inside the project run without asking (outside paths, shell, web still ask). */
export const AUTO_EDIT_RULE = { permission: "edit", pattern: "*", action: "allow" } as const

export const approve = Effect.fn("EzkPlan.approve")(function* (input: {
  sessionID: SessionID
  mode: ApprovalMode
  /** the plan as edited by the user; default: the plan agent's last reply */
  text?: string
  lang?: "en" | "id"
}) {
  const sessions = yield* Session.Service
  const state = yield* SessionRunState.Service
  const todo = yield* Todo.Service
  const agents = yield* Agent.Service
  const prompt = yield* SessionPrompt.Service
  yield* state.assertNotBusy(input.sessionID)

  const messages = yield* sessions.messages({ sessionID: input.sessionID })
  const plan = input.text?.trim() || pendingPlan(messages)?.text
  if (!plan) return yield* Effect.fail(new Error("no plan to approve"))

  // untrusted folders are always forced to ask (safety rule of the permission modes)
  const ctx = yield* InstanceState.context
  const mode: ApprovalMode = input.mode === "auto" && projectTrusted(ctx.directory, ctx.worktree) ? "auto" : "ask"
  const session = yield* sessions.get(input.sessionID)
  const others = (session.permission ?? []).filter(
    (r) => !(r.permission === AUTO_EDIT_RULE.permission && r.pattern === AUTO_EDIT_RULE.pattern && r.action === AUTO_EDIT_RULE.action),
  )
  yield* sessions.setPermission({ sessionID: input.sessionID, permission: mode === "auto" ? [...others, { ...AUTO_EDIT_RULE }] : others })

  const todos = planTodos(plan)
  if (todos.length) yield* todo.update({ sessionID: input.sessionID, todos: todos.map((t, i) => (i === 0 ? { ...t, status: "in_progress" } : t)) })

  const messageID = MessageID.ascending()
  planStore().save(input.sessionID, { plan, messageID, mode })
  const lastUser = messages.findLast((m) => m.info.role === "user")?.info as SessionV1.User | undefined
  const build = (yield* agents.get("build")) ? "build" : yield* agents.defaultAgent()
  yield* prompt
    .prompt({
      sessionID: input.sessionID,
      messageID,
      agent: build,
      ...(lastUser?.model ? { model: { providerID: lastUser.model.providerID, modelID: lastUser.model.modelID } } : {}),
      ...(lastUser?.model?.variant ? { variant: lastUser.model.variant } : {}),
      parts: [
        { type: "text", text: approvalText(mode, input.lang) },
        { type: "text", text: approvalInstruction(plan, mode), synthetic: true },
      ],
    })
    .pipe(
      Effect.catchCause((cause) => Effect.logError("plan approval prompt failed", { sessionID: input.sessionID, cause })),
      Effect.forkDetach,
    )
  return { mode, messageID, todos: todos.length, planPath: planStore().planPath(input.sessionID), forced: mode !== input.mode }
})
