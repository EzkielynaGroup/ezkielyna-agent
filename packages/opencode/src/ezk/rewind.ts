// Ezkielyna Agent v3 U2: /rewind on top of the shadow-git snapshots (core/src/ezk/ux/checkpoints.ts has the logic).
//   files     restore what the agent changed after the checkpoint; files changed outside the agent are left alone
//   chat      hide the later turns (the normal revert marker, so /redo brings them back); files untouched
//   both      files + chat; /redo restores both
//   summarize replace the later turns with one cheap-model summary (cannot be undone); files untouched
import path from "node:path"
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Global } from "@opencode-ai/core/global"
import { loadFlags } from "@opencode-ai/core/ezk/flags"
import {
  type Checkpoint,
  type RewindMode,
  SUMMARY_PROMPT,
  diskUsage,
  lastAgentSnapshot,
  listCheckpoints,
  planFileRestore,
  summaryDigest,
  summaryMessage,
} from "@opencode-ai/core/ezk/ux/checkpoints"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { cheapText } from "./cheap"
import { planStore } from "./plan-store"

export interface RewindResult {
  mode: RewindMode
  restored: string[]
  /** changed outside the agent since its last step: left alone */
  skipped: string[]
  /** the whole project as it was right before this rewind (restore it to undo a files-only rewind) */
  undo?: string
  summaryMessageID?: string
  warning?: "no-snapshot"
}

export const checkpoints = Effect.fn("EzkRewind.checkpoints")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID)
  const all = yield* sessions.messages({ sessionID })
  const visible = session.revert ? all.filter((m) => m.info.id < session.revert!.messageID) : all
  const ctx = yield* InstanceState.context
  const bytes = yield* Effect.promise(() => diskUsage(path.join(Global.Path.data, "snapshot", ctx.project.id)))
  return { checkpoints: listCheckpoints(visible, loadFlags([Global.Path.config]).rewind.max), diskBytes: bytes }
})

export const rewind = Effect.fn("EzkRewind.rewind")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  mode: RewindMode
  lang?: "en" | "id"
}) {
  const sessions = yield* Session.Service
  const revert = yield* SessionRevert.Service
  const state = yield* SessionRunState.Service
  yield* state.assertNotBusy(input.sessionID)
  // a pending /undo is put back first (non-destructive), so the transcript below is the real one
  if ((yield* sessions.get(input.sessionID)).revert) yield* revert.unrevert({ sessionID: input.sessionID })

  const messages = yield* sessions.messages({ sessionID: input.sessionID })
  const cp = listCheckpoints(messages, Number.MAX_SAFE_INTEGER).find((c) => c.messageID === input.messageID)
  if (!cp) return yield* Effect.fail(new Error("checkpoint not found"))
  if (input.mode !== "files") forgetPlanIfRewound(input.sessionID, input.messageID)

  if (input.mode === "summarize") return yield* summarize({ ...input, messages, cp })

  const files: Pick<RewindResult, "restored" | "skipped" | "undo" | "warning"> =
    input.mode === "chat" ? { restored: [], skipped: [] } : yield* restoreFiles(messages, cp)
  if (input.mode === "files") return { mode: input.mode, ...files } satisfies RewindResult

  // chat / both: the standard revert marker hides the later turns; /redo (unrevert) restores `snapshot` when files moved
  const summary = yield* SessionSummary.Service
  const index = messages.findIndex((m) => m.info.id === input.messageID)
  const diffs = yield* summary.computeDiff({ messages: messages.slice(index) })
  yield* sessions.setRevert({
    sessionID: input.sessionID,
    revert: { messageID: input.messageID, ...(files.undo ? { snapshot: files.undo } : {}) },
    summary: {
      additions: diffs.reduce((sum, x) => sum + x.additions, 0),
      deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
      files: diffs.length,
    },
  })
  return { mode: input.mode, ...files } satisfies RewindResult
})

/** Undo a files-only rewind: put the whole project back to the snapshot taken right before it. */
export const undoFiles = Effect.fn("EzkRewind.undoFiles")(function* (input: { sessionID: SessionID; snapshot: string }) {
  const state = yield* SessionRunState.Service
  yield* state.assertNotBusy(input.sessionID)
  const snap = yield* Snapshot.Service
  yield* snap.restore(input.snapshot)
})

const restoreFiles = Effect.fn("EzkRewind.restoreFiles")(function* (messages: SessionV1.WithParts[], cp: Checkpoint) {
  if (!cp.snapshot) return { restored: [], skipped: [], warning: "no-snapshot" as const }
  const snap = yield* Snapshot.Service
  const undo = yield* snap.track()
  const agent = lastAgentSnapshot(messages)
  const changedOutside = agent ? (yield* snap.patch(agent)).files : []
  const plan = planFileRestore({ agentFiles: cp.files, changedOutside })
  if (plan.restore.length) yield* snap.revert([{ hash: cp.snapshot, files: plan.restore }])
  return { restored: plan.restore, skipped: plan.skipped, ...(undo ? { undo } : {}) }
})

const summarize = Effect.fn("EzkRewind.summarize")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  lang?: "en" | "id"
  messages: SessionV1.WithParts[]
  cp: Checkpoint
}) {
  const sessions = yield* Session.Service
  const revert = yield* SessionRevert.Service
  const target = input.messages.find((m) => m.info.id === input.messageID)!.info as SessionV1.User
  // the summary is written before anything is removed: a failed call changes nothing
  const written = yield* cheapText({
    system: SUMMARY_PROMPT,
    prompt: summaryDigest(input.messages, input.messageID),
    maxOutputTokens: 600,
    fallback: target.model,
  })
  if (!written.text) return yield* Effect.fail(new Error("empty summary"))
  const current = yield* sessions.get(input.sessionID)
  yield* sessions.setRevert({ sessionID: input.sessionID, revert: { messageID: input.messageID }, summary: current.summary })
  yield* revert.cleanup(yield* sessions.get(input.sessionID))
  const msg: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: target.agent,
    model: target.model,
  }
  yield* sessions.updateMessage(msg)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "text",
    text: summaryMessage(written.text, input.cp.turns, input.lang),
    metadata: { ezk: "rewind-summary", model: written.model },
  } satisfies SessionV1.TextPart)
  return { mode: "summarize", restored: [], skipped: [], summaryMessageID: msg.id } satisfies RewindResult
})

/** Rewinding to (or before) the plan approval un-approves the plan, so compaction no longer re-injects it. */
function forgetPlanIfRewound(sessionID: string, messageID: string) {
  const approved = planStore().get(sessionID)
  if (approved && approved.messageID >= messageID) planStore().clear(sessionID)
}
