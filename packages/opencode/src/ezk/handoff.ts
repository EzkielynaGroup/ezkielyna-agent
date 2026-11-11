// Ezkielyna Agent v3 C4: /handoff <goal>. A cheap model writes the first message of a fresh session from this one;
// the file list comes from the transcript. The new session is created empty and the client opens it with the text
// prefilled in the prompt box, so the user can edit it before sending.
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { HANDOFF_SYSTEM, handoffDigest, handoffFiles, handoffPrompt, handoffRequest } from "@opencode-ai/core/ezk/ux/handoff"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { cheapText } from "./cheap"

export const handoff = Effect.fn("EzkHandoff.handoff")(function* (input: { sessionID: SessionID; goal: string }) {
  const goal = input.goal.trim()
  if (!goal) return yield* Effect.fail(new Error("goal required"))
  const sessions = yield* Session.Service
  const ctx = yield* InstanceState.context
  const messages = yield* sessions.messages({ sessionID: input.sessionID })
  const files = handoffFiles(messages, ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory)
  const lastUser = messages.findLast((m) => m.info.role === "user")?.info as SessionV1.User | undefined
  // a failed or empty call still hands off: the goal + file list alone are a usable start
  const written = yield* cheapText({
    system: HANDOFF_SYSTEM,
    prompt: handoffRequest(goal, handoffDigest(messages), files),
    maxOutputTokens: 700,
    fallback: lastUser?.model,
  }).pipe(Effect.catch(() => Effect.succeed({ text: "", model: undefined })))
  const parent = yield* sessions.get(input.sessionID)
  const next = yield* sessions.create({ title: `Handoff: ${goal.slice(0, 60)}` })
  return {
    sessionID: next.id,
    prompt: handoffPrompt(written.text, goal, files),
    files,
    model: written.model,
    agent: lastUser?.agent ?? parent.agent,
    from: input.sessionID,
  }
})
