import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { reviewerFor } from "@opencode-ai/core/ezk/model-policy"
import { TOOL_DESCRIPTION, snapshot } from "@opencode-ai/core/ezk/memory/block"
import { type EzkRuntime, ezkRuntime } from "./runtime"
import { reviewGate } from "./review-gate"

// Ezkielyna Agent v1.1: curated memory plugin (track M).
//   system.transform  -> one frozen <memory> block per session (never changes mid-session: prompt cache stays valid)
//   tool `memory`     -> add / replace / remove, budget + secret scanner enforced by the store
//   session.idle      -> post-turn reviewer on a Flash model (flag ezk.memory.review), every N turns or after "remember ..."
// Private sessions: no block, no tool writes, no reviewer.

const SMALL_TASK_PROMPTS = /^(You are a title generator|Summarize what was done)/
const EXPLICIT_REMEMBER = /\b(remember|don'?t forget|keep in mind|note that|from now on)\b|\b(ingat|jangan lupa|catat|mulai sekarang|selalu)\b/i
const MAX_TRACKED = 300

function capMap<K, V>(m: Map<K, V>) {
  if (m.size > MAX_TRACKED) m.delete(m.keys().next().value as K)
}

export async function EzkMemoryPlugin(input: PluginInput): Promise<Hooks> {
  const rt = ezkRuntime()
  if (!rt.flags.memory.enabled) return {}

  return {
    tool: {
      memory: tool({
        description: TOOL_DESCRIPTION,
        args: {
          action: tool.schema.enum(["add", "replace", "remove"]),
          store: tool.schema.enum(["memory", "user"]),
          text: tool.schema.string().optional(),
          match: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          if (rt.memState.isPrivate(ctx.sessionID)) return "Private session: nothing was saved."
          await ctx.ask({
            permission: "ezk_memory",
            patterns: [args.action, args.store, args.action === "remove" ? args.match ?? "" : args.text ?? ""],
            always: [],
            metadata: { action: args.action, store: args.store, project: ctx.worktree },
          })
          const r =
            args.action === "add"
              ? rt.memory.add(args.store, args.text ?? "")
              : args.action === "replace"
                ? rt.memory.replace(args.store, args.match ?? "", args.text ?? "")
                : rt.memory.remove(args.store, args.match ?? "")
          if (!r.ok) return `Not saved: ${r.error}`
          return `Saved (${args.store} ${r.chars}/${r.limit} chars${r.note ? `, ${r.note}` : ""}). Applies from the next session.`
        },
      }),
    },

    async "experimental.chat.system.transform"(inp, out) {
      const sessionID = inp.sessionID
      if (!sessionID || !out.system[0] || SMALL_TASK_PROMPTS.test(out.system[0])) return
      if (rt.memState.isPrivate(sessionID)) return
      let block = rt.frozen.get(sessionID)
      if (block === undefined) {
        block = snapshot(rt.memory)
        rt.frozen.set(sessionID, block)
        capMap(rt.frozen)
      }
      if (block) out.system[0] = `${out.system[0]}\n\n${block}`
    },

    async "experimental.session.compacting"(inp, out) {
      if (!rt.flags.compaction.enabled || rt.memState.isPrivate(inp.sessionID)) return
      let block = rt.frozen.get(inp.sessionID)
      if (block === undefined) {
        block = snapshot(rt.memory)
        rt.frozen.set(inp.sessionID, block)
        capMap(rt.frozen)
      }
      if (block) out.context.push(`Memory to restore after compaction:\n${block}`)
    },

    async "chat.message"(_i, out) {
      const sessionID = out.message.sessionID
      reviewGate.clear(sessionID)
      if (rt.memState.isPrivate(sessionID)) return
      rt.reviewTurns.set(sessionID, (rt.reviewTurns.get(sessionID) ?? 0) + 1)
      capMap(rt.reviewTurns)
      const text = out.parts.map((p: any) => (p.type === "text" && !p.synthetic ? p.text : "")).join(" ")
      if (EXPLICIT_REMEMBER.test(text)) rt.reviewExplicit.add(sessionID)
    },

    async event({ event }) {
      const e = event as any
      if (e.type !== "session.idle" || !rt.flags.memory.review) return
      const sessionID: string | undefined = e.properties?.sessionID
      if (!sessionID) return
      const state = rt.memState.get()
      const { reviewDue } = await import("@opencode-ai/core/ezk/memory/reviewer")
      const due = reviewDue({
        enabled: true,
        private: state.privateSessions.includes(sessionID),
        turnsSince: rt.reviewTurns.get(sessionID) ?? 0,
        every: rt.flags.memory.reviewEvery,
        explicit: rt.reviewExplicit.has(sessionID),
        state,
        now: Date.now(),
      })
      if (!due) return
      if (!reviewGate.claim(sessionID)) return
      rt.reviewTurns.set(sessionID, 0)
      rt.reviewExplicit.delete(sessionID)
      void runReview(rt, input, sessionID)
    },
  }
}

/** One non-streaming Flash call with a compact digest. Never throws; the outcome lands in rt.lastReview. */
export async function runReview(rt: EzkRuntime, input: PluginInput, sessionID: string) {
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  rt.memState.update((s) => {
    s.lastReviewAt = now
    s.reviews = { day, count: (s.reviews.day === day ? s.reviews.count : 0) + 1 }
  })
  try {
    const { REVIEW_SYSTEM, applyOps, buildDigest, parseOps } = await import("@opencode-ai/core/ezk/memory/reviewer")
    await rt.ensureAllowed()
    const model = reviewerFor(rt.engine.policy, rt.engine.allowed)
    const key = rt.key()
    if (!model || !key) throw new Error("no reviewer model or key")
    const res: any = await (input.client as any).session.messages({ path: { id: sessionID } })
    const list: any[] = res?.data ?? res ?? []
    const messages = list
      .map((m) => ({
        role: m.info?.role as "user" | "assistant",
        text: (m.parts ?? []).filter((p: any) => p.type === "text" && !p.synthetic && !p.ignored).map((p: any) => p.text).join(" "),
      }))
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.text)
    if (!messages.length) return
    const r = await fetch(`${rt.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: "system", content: REVIEW_SYSTEM },
          { role: "user", content: buildDigest(messages, rt.memory) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!r.ok) throw new Error(`reviewer HTTP ${r.status}`)
    const json = (await r.json()) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } }
    const applied = applyOps(rt.memory, parseOps(json.choices?.[0]?.message?.content ?? ""))
    rt.lastReview = {
      at: Date.now(),
      applied: applied.filter((a) => a.ok).length,
      rejected: applied.filter((a) => !a.ok).map((a) => a.error ?? "rejected"),
      model,
      tokens: json.usage?.total_tokens,
    }
  } catch (err) {
    rt.lastReview = { at: Date.now(), applied: 0, rejected: [], error: err instanceof Error ? err.message : String(err) }
  }
}

