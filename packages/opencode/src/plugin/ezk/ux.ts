// Ezkielyna Agent v3 "ux" lane plugin. Thin glue between OpenCode hooks and core/src/ezk/ux/*:
//   config                               subagents: explorer prompt + turn cap, read-only planner, `.claude/agents`
//                                        (trusted folders only), `model: light|heavy`, `maxTurns`, `permissionMode`
//   chat.message                         subagent turns of a tiered agent run on the key's light/heavy model
//   tool.execute.after                   a subagent result handed back to the parent is capped (~2k tokens)
//   experimental.chat.messages.transform the approved plan comes back after compaction (appended, cache-safe)
// Every hook is a no-op while its flag is off.
import os from "node:os"
import path from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Glob } from "@opencode-ai/core/util/glob"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { needsPlanReminder, planReminder } from "@opencode-ai/core/ezk/ux/plan"
import {
  PLANNER_DESCRIPTION,
  PLANNER_PROMPT,
  type AgentConfig,
  type Tier,
  capResult,
  explorePrompt,
  fromClaudeAgent,
  normalizeAgent,
  subagentModel,
} from "@opencode-ai/core/ezk/ux/subagents"
import { ConfigMarkdown } from "@/config/markdown"
import { projectTrusted } from "@/config/trust"
import { planStore } from "@/ezk/plan-store"
import { ezkRuntime } from "./runtime"

const READ_ONLY = { "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow", lsp: "allow" } as const

export async function EzkUxPlugin(input: PluginInput): Promise<Hooks> {
  const rt = ezkRuntime()
  const flags = rt.flags
  if (!flags.subagents.enabled && !flags.planApproval.enabled) return {}
  const tiers = new Map<string, Tier>()

  const hooks: Hooks = {}

  if (flags.subagents.enabled) {
    hooks.config = async (cfg: any) => {
      cfg.agent ??= {}
      const agents = cfg.agent as Record<string, AgentConfig>
      const explore = agents.explore ?? {}
      agents.explore = {
        ...explore,
        prompt: explore.prompt ?? explorePrompt(flags.subagents.exploreTurns),
        steps: explore.steps ?? flags.subagents.exploreTurns,
        options: { ezkTier: "light", ...explore.options },
      }
      agents.planner ??= {
        description: PLANNER_DESCRIPTION,
        prompt: PLANNER_PROMPT,
        mode: "subagent",
        permission: { ...READ_ONLY, webfetch: "ask" },
        options: { ezkTier: "heavy" },
      }
      for (const [name, agent] of Object.entries(await claudeAgents(input))) agents[name] ??= agent
      for (const [name, agent] of Object.entries(agents)) {
        if (!agent || typeof agent !== "object") continue
        const next = normalizeAgent(agent)
        agents[name] = next
        const tier = next.options?.ezkTier
        if (tier === "light" || tier === "heavy") tiers.set(name, tier)
      }
    }

    hooks["chat.message"] = async (_i, out) => {
      const msg = out.message
      const tier = tiers.get(msg.agent)
      if (!tier || msg.model.providerID !== EZK.providerID) return
      await rt.ensureAllowed().catch(() => undefined)
      const id = subagentModel({
        tier,
        policy: rt.engine.policy,
        allowed: rt.engine.allowed,
        price: (m) => {
          const p = rt.prices.get(m)
          return p ? p.ratio * (p.groupRatio || 1) : undefined
        },
      })
      if (id) msg.model = { ...msg.model, providerID: EZK.providerID, modelID: id } as typeof msg.model
    }

    hooks["tool.execute.after"] = async (i, out) => {
      if (i.tool !== "task" || typeof out.output !== "string") return
      out.output = capResult(out.output, flags.subagents.resultTokens)
    }
  }

  if (flags.planApproval.enabled) {
    hooks["experimental.chat.messages.transform"] = async (_i, out) => {
      const messages = out.messages
      const sessionID = messages[0]?.info.sessionID
      if (!sessionID) return
      const approved = planStore().get(sessionID)
      if (!needsPlanReminder(messages as any, approved)) return
      // the first user message after compaction is stable across turns, so the reminder never moves (cache rule)
      const first = messages.find((m) => m.info.role === "user")
      if (!first) return
      first.parts.push({
        id: `prt_ezkplan${first.info.id.slice(3)}`,
        messageID: first.info.id,
        sessionID,
        type: "text",
        text: planReminder(approved!.plan),
        synthetic: true,
      } as any)
    }

    if (flags.compaction.enabled) {
      hooks["experimental.session.compacting"] = async (inp, out) => {
        const approved = planStore().get(inp.sessionID)
        if (approved) out.context.push(`Approved plan to restore after compaction:\n${approved.plan}`)
      }
    }
  }

  return hooks
}

/** `.claude/agents/*.md`: the user's own (~/.claude) always, the project's only when the folder is trusted. */
async function claudeAgents(input: PluginInput) {
  const root = input.worktree && input.worktree !== "/" ? input.worktree : input.directory
  const dirs = [path.join(os.homedir(), ".claude", "agents"), ...(projectTrusted(input.directory, input.worktree) ? [path.join(root, ".claude", "agents")] : [])]
  const out: Record<string, AgentConfig> = {}
  for (const dir of dirs) {
    const files = await Glob.scan("*.md", { cwd: dir, absolute: true, dot: false }).catch(() => [] as string[])
    for (const file of files) {
      const md = await ConfigMarkdown.parse(file).catch(() => undefined)
      if (!md) continue
      const data = (md.data ?? {}) as Record<string, unknown>
      const name = typeof data.name === "string" && /^[\w.-]{1,64}$/.test(data.name) ? data.name : path.basename(file, ".md")
      out[name] = fromClaudeAgent(data, md.content, EZK.providerID)
    }
  }
  return out
}
