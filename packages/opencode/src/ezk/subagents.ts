// Ezkielyna Agent v3 E3: subagents ON, lazily. Two small runtime pieces used from hot files:
//   taskAgent()      session/prompt.ts: the agent whose permissions the tool list is built from, with `task` let in
//                    only once the session needs it (core shouldExposeTask), so short tasks keep identical prompt bytes
//   limitSubagents() session/tools.ts: at most N subagents of one parent session run at the same time
// Agent definitions (explorer prompt and turn cap, the read-only planner, `.claude/agents`) are added by the ux plugin.
import { Effect, Semaphore } from "effect"
import { LAZY_DENIED_SUBAGENTS, shouldExposeTask } from "@opencode-ai/core/ezk/ux/subagents"
import { loadFlags } from "@opencode-ai/core/ezk/flags"
import { Global } from "@opencode-ai/core/global"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export function taskAgent(agent: Agent.Info, messages: SessionV1.WithParts[]): Agent.Info {
  const flags = loadFlags([Global.Path.config]).subagents
  if (!flags.enabled || agent.mode === "subagent") return agent
  // `task` already allowed (the user turned it on in config): unchanged upstream behaviour
  if (!Permission.disabled(["task"], agent.permission).has("task")) return agent
  if (!shouldExposeTask(messages, flags.minReads)) return agent
  return {
    ...agent,
    permission: [
      ...agent.permission,
      { permission: "task", pattern: "*", action: "allow" },
      ...LAZY_DENIED_SUBAGENTS.map((name) => ({ permission: "task", pattern: name, action: "deny" as const })),
    ],
  }
}

const slots = new Map<string, Semaphore.Semaphore>()

export function limitSubagents<A, E, R>(toolID: string, sessionID: string, effect: Effect.Effect<A, E, R>) {
  const flags = loadFlags([Global.Path.config]).subagents
  if (toolID !== "task" || !flags.enabled) return effect
  let sem = slots.get(sessionID)
  if (!sem) {
    sem = Semaphore.makeUnsafe(flags.maxConcurrent)
    slots.set(sessionID, sem)
    if (slots.size > 500) slots.delete(slots.keys().next().value!)
  }
  return sem.withPermits(1)(effect)
}
