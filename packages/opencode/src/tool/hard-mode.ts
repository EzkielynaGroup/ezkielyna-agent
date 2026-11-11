import { chainFor } from "@opencode-ai/core/ezk/model-policy"
import { Schema, Effect } from "effect"
import { detectVerify } from "@opencode-ai/core/ezk/context/session-start"
import * as Tool from "./tool"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { projectTrusted } from "@/config/trust"
import { ezkRuntime, restoreSessionCosts } from "@/plugin/ezk/runtime"
import { runHardMode, type HardModeResult } from "@/ezk/hard-mode"

type HardModeToolMetadata = {
  attempts: HardModeResult["attempts"]
  chosen?: number
  costUSD: number
  applied: boolean
}

export const Parameters = Schema.Struct({
  task: Schema.String.annotate({ description: "The task to implement in three isolated attempts" }),
})

export const HardModeTool = Tool.define(
  "hard_mode",
  Effect.gen(function* () {
    return {
      description:
        "Run three isolated best-of-three implementation attempts on the Flash tier. Each attempt uses the detected project verify command. Failed and duplicate diffs are discarded; the selected diff is shown for explicit approval before it is applied.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const root = instance.directory && instance.directory !== "/" ? instance.directory : instance.worktree
          const rt = ezkRuntime()
          const verify = detectVerify(root)
          if (!verify) return unavailable("Hard mode unavailable", "Hard mode needs a detected verify command in this project.")
          if (!projectTrusted(root, instance.worktree)) {
            return unavailable("Hard mode unavailable", "Trust this project first; hard mode runs edits and the project's verify command in temporary worktrees.")
          }
          if (!rt.flags.loop.hard) {
            return unavailable("Hard mode unavailable", "Hard mode is experimental and disabled. Enable `loop.hard` to use `/hard`.")
          }

          yield* Effect.promise(() => rt.ensureAllowed())
          const model = chainFor(rt.engine.policy, "light", rt.engine.allowed).find((id) => rt.engine.policy.flash.includes(id))
          if (!model) return unavailable("Hard mode unavailable", "No allowed Flash model is available for these attempts.")
          yield* Effect.promise(() => restoreSessionCosts(rt, ctx.sessionID))
          const remaining = rt.engine.capUSD - rt.engine.spentUSD(ctx.sessionID)
          if (remaining <= 0) return unavailable("Hard mode budget exhausted", "The session cost cap has no remaining budget for hard mode.")

          yield* ctx.ask({
            permission: "bash",
            patterns: ["run 3 isolated hard-mode attempts and the detected verify command"],
            always: [],
            metadata: { command: "Start three temporary hard-mode attempts", verify: verify.command, budgetUSD: remaining },
            forceAsk: true,
          })

          const bridge = yield* EffectBridge.make()
          const result = yield* Effect.promise(() =>
            runHardMode({
              root,
              task: params.task,
              verify,
              model,
              totalBudgetUSD: remaining,
              signal: ctx.abort,
              onCost: (runID, totalCostUSD) => {
                const messageID = `hard:${runID}`
                rt.engine.setMessageCost(ctx.sessionID, messageID, totalCostUSD)
                rt.costs.setMessageCost(ctx.sessionID, messageID, totalCostUSD)
              },
              confirmVerify: async ({ command, files, attempt }) => {
                try {
                  await bridge.promise(ctx.ask({
                    permission: "bash",
                    patterns: [command],
                    always: [],
                    metadata: {
                      command,
                      note: `No OS sandbox is available, so the verify command would run directly. Attempt ${attempt} edited these files: ${files.slice(0, 30).join(", ") || "(none listed)"}. Run it on this attempt?`,
                    },
                    forceAsk: true,
                  }))
                  return true
                } catch {
                  return false
                }
              },
              onSummary: (summary) => bridge.promise(ctx.metadata({ title: "Hard mode candidates", metadata: { summary } })),
              approveApply: async ({ summary, attempt, diff, paths }) => {
                await bridge.promise(ctx.metadata({ title: `Hard mode attempt ${attempt}`, metadata: { summary } }))
                try {
                  await bridge.promise(ctx.ask({
                    permission: "edit",
                    patterns: paths,
                    always: [],
                    metadata: { diff, summary, attempt, verify: verify.command },
                    forceAsk: true,
                  }))
                  return true
                } catch {
                  return false
                }
              },
            }),
          )

          rt.engine.setMessageCost(ctx.sessionID, `hard:${result.runID}`, result.totalCostUSD)
          rt.costs.setMessageCost(ctx.sessionID, `hard:${result.runID}`, result.totalCostUSD)
          return {
            title: "Hard mode",
            metadata: {
              attempts: result.attempts,
              ...(result.chosen ? { chosen: result.chosen.attempt } : {}),
              costUSD: result.totalCostUSD,
              applied: result.applied,
            } satisfies HardModeToolMetadata,
            output: result.summary,
          }
        }),
    }
  }),
)

function unavailable(title: string, output: string): Tool.ExecuteResult<HardModeToolMetadata> {
  return { title, metadata: { attempts: [], costUSD: 0, applied: false }, output }
}
