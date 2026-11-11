import { randomUUID } from "node:crypto"
import readline from "node:readline/promises"
import { stdin, stderr } from "node:process"
import { detectVerify } from "@opencode-ai/core/ezk/context/session-start"
import { ezkRuntime } from "@/plugin/ezk/runtime"
import { projectTrusted } from "@/config/trust"
import { runHardMode } from "./hard-mode"

export async function runHardCLI(input: {
  prompt: string
  directory: string
  json: boolean
  maxBudgetUSD?: number
  write: (line: string) => void
  log: (line: string) => void
}) {
  const verify = detectVerify(input.directory)
  if (!verify) {
    input.log("Hard mode needs a detected verify command in this project.")
    return 1
  }
  if (!projectTrusted(input.directory)) {
    input.log("Trust this project first; hard mode runs edits and the verify command in temporary worktrees.")
    return 1
  }
  const rt = ezkRuntime()
  if (!rt.flags.loop.hard) {
    input.log("Hard mode is experimental and disabled. Enable `loop.hard` to use --hard.")
    return 1
  }
  await rt.ensureAllowed()
  const model = rt.engine.policy.flash.find((id) => rt.engine.allowed.ids.has(id))
  if (!model) {
    input.log("No allowed Flash model is available for hard mode.")
    return 1
  }
  const cap = rt.engine.capUSD > 0 ? rt.engine.capUSD : input.maxBudgetUSD ?? 0
  const budget = input.maxBudgetUSD === undefined ? cap : Math.min(cap, input.maxBudgetUSD)
  if (!(budget > 0)) {
    input.log("Hard mode needs a positive remaining cost cap; set ezk.router.capUSD or pass --max-budget.")
    return 1
  }

  const threadID = randomUUID()
  const summaryID = `hard-summary-${threadID}`
  const diffID = `hard-diff-${threadID}`
  if (input.json) {
    emit(input, { type: "thread.started", thread_id: threadID })
    emit(input, { type: "turn.started" })
  }
  const result = await runHardMode({
    root: input.directory,
    task: input.prompt,
    verify,
    model,
    totalBudgetUSD: budget,
    onSummary(summary) {
      if (input.json) {
        emit(input, { type: "item.completed", item: { id: summaryID, type: "agent_message", text: summary } })
      } else {
        input.write(summary)
      }
    },
    async approveApply({ attempt, diff }) {
      if (input.json) {
        emit(input, { type: "item.completed", item: { id: diffID, type: "agent_message", text: `Selected diff (attempt ${attempt}):\n${diff}` } })
      } else {
        input.write(`\nSelected diff (attempt ${attempt}):\n${diff}`)
      }
      if (!stdin.isTTY) {
        input.log("No interactive approval is available; the candidate remains unapplied.")
        return false
      }
      const rl = readline.createInterface({ input: stdin, output: stderr })
      try {
        const answer = await rl.question(`Apply attempt ${attempt} to the current working tree? Type yes to approve: `)
        return answer.trim().toLowerCase() === "yes"
      } finally {
        rl.close()
      }
    },
  })
  if (input.json) {
    emit(input, {
      type: "item.completed",
      item: {
        id: `hard-result-${threadID}`,
        type: "agent_message",
        text: result.status === "applied"
          ? `Applied attempt ${result.chosen?.attempt} after approval.`
          : result.status === "approval-declined"
            ? "The selected diff was not applied."
            : result.status === "budget-exhausted"
              ? "Hard mode stopped at its cost cap."
              : "No verified applicable candidate was selected.",
      },
    })
    emit(input, { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } })
  } else if (result.status === "applied") {
    input.log(`Applied attempt ${result.chosen?.attempt} after approval.`)
  } else if (result.status === "approval-declined") {
    input.log("The selected diff was not applied.")
  }
  return result.status === "budget-exhausted" ? 2 : result.status === "no-candidate" ? 1 : 0
}

function emit(input: { write: (line: string) => void }, event: Record<string, unknown>) {
  input.write(JSON.stringify(event))
}
