import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { pickDefaultModel } from "@opencode-ai/core/ezkielyna"
import { EZK_AUTO_MODEL_ID, EZK_AUTO_MODEL_NAME, type RouteInfo } from "@opencode-ai/core/ezk/contracts"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { isAlias } from "@opencode-ai/core/ezk/model-policy"
import { costUSD } from "@opencode-ai/core/ezk/pricing"
import { classify, parseTierPrefix, tinyClassify } from "@opencode-ai/core/ezk/router/classify"
import type { LoopMessage } from "@opencode-ai/core/ezk/loop/policy"
import { readEzkConfig } from "@opencode-ai/core/ezk/flags"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import { isError } from "@opencode-ai/core/ezk/router/engine"
import { H_MESSAGE, H_SESSION } from "@opencode-ai/core/ezk/router/fetch"
import { ezkRuntime, installRoutedFetch, restoreSessionCosts } from "./runtime"
import { projectTrusted } from "@/config/trust"

// Ezkielyna Agent v1.1: Auto router plugin. Thin glue between OpenCode hooks and core/src/ezk/router/*.
//   chat.message                   -> one decision per user message (ezk-auto is rewritten to a real model)
//   chat.headers                   -> marks routed requests so the routed fetch may fall back for them
//   experimental.model.select      -> mid-turn escalation and sticky fallback (the one core hook patch)
//   tool.execute.after / event     -> router signals, per-session cost
// Everything is a no-op unless the user selected "Auto" (ezk-auto); a pinned model or a gateway alias is never rerouted.

const MAX_TRACKED = 500
const seenToolErrors = new Set<string>()

/** Virtual model entry shown in the pickers. Rewritten before any request is made. */
const virtualModel = {
  name: EZK_AUTO_MODEL_NAME[detectLang()],
  tool_call: true,
  temperature: true,
  attachment: false,
  reasoning: false,
  limit: { context: 128_000, input: 100_000, output: 16_384 },
  modalities: { input: ["text"], output: ["text"] },
  cost: { input: 0, output: 0 },
}

export async function EzkRouterPlugin(input: PluginInput): Promise<Hooks> {
  const rt = ezkRuntime()
  if (rt.flags.router.enabled) installRoutedFetch(rt)
  const trackLoop = Object.values(rt.flags.loop).some(Boolean)
  const loopHelpers = trackLoop ? await import("@opencode-ai/core/ezk/loop/policy") : undefined
  const loopState = trackLoop ? await rt.loop() : undefined
  const intentClassifier = rt.flags.loop.plan ? await import("@opencode-ai/core/ezk/intent/classify") : undefined
  const planApprovalStore = rt.flags.loop.plan ? (await import("@/ezk/plan-store")).planStore : undefined
  const projectRoot = input.worktree && input.worktree !== "/" ? input.worktree : input.directory

  // loop reminders already sent: re-inserted after the same anchor message on later requests, so the prompt prefix
  // (and its cache) stays byte-identical instead of the reminder vanishing from the next request.
  const sentReminders = new Map<string, { anchorID: string; message: any }[]>()
  const MAX_SENT_REMINDERS = 20

  const remember = (id: string) => {
    rt.autoMessages.add(id)
    if (rt.autoMessages.size > MAX_TRACKED) rt.autoMessages.delete(rt.autoMessages.values().next().value!)
  }

  return {
    async config(cfg: any) {
      if (!rt.flags.router.enabled) return
      cfg.provider ??= {}
      cfg.provider[EZK.providerID] ??= {}
      cfg.provider[EZK.providerID].models = {
        ...cfg.provider[EZK.providerID].models,
        [EZK_AUTO_MODEL_ID]: { ...virtualModel, ...cfg.provider[EZK.providerID].models?.[EZK_AUTO_MODEL_ID] },
      }
    },

    async "chat.message"(_input, out) {
      const msg = out.message
      const sessionID = msg.sessionID
      const messageID = msg.id
      const picked = msg.model.modelID
      const textParts = out.parts.filter((p: any) => p.type === "text" && !p.synthetic && !p.ignored) as { text: string }[]
      let prompt = textParts.map((p) => p.text).join("\n")
      let prefixed = parseTierPrefix(prompt)
      const auto = rt.flags.router.enabled && msg.model.providerID === EZK.providerID && picked === EZK_AUTO_MODEL_ID
      const syntheticReminder = (textParts.length === 0 && out.parts.some((p: any) => p.synthetic)) ||
        (textParts.length === 1 && /^<system-reminder>[\s\S]*<\/system-reminder>$/i.test(textParts[0]!.text.trim()))

      if (auto && prefixed.forced && textParts[0]) {
        textParts[0].text = parseTierPrefix(textParts[0].text).text
        prompt = prefixed.text
      }

      const classified = classify({ prompt, planMode: msg.agent === "plan" })
      // the plan-approval message (saved in the plan store, carries a synthetic instruction) must run as build
      const isApprovalMessage = planApprovalStore?.().get(sessionID)?.messageID === messageID
      const intent = intentClassifier?.classifyIntent(prompt)
      const isQa = intent === "qa" || (loopHelpers?.questionOnly(prompt) ?? false)
      const forcePlan = !syntheticReminder && !isApprovalMessage && rt.flags.loop.plan && msg.model.providerID === EZK.providerID && classified.tier === "heavy" && !isQa
      const approval = forcePlan && planApprovalEnabled(rt.flags, projectRoot, projectTrusted(input.directory, input.worktree))
      if (approval) msg.agent = "plan"
      const loopDecision = !trackLoop
        ? undefined
        : syntheticReminder
          ? { phase: loopHelpers!.phaseFor({ prompt, planMode: msg.agent === "plan" }) }
          : loopState!.beginTurn(sessionID, {
            messageID,
            prompt,
            planMode: msg.agent === "plan",
            forced: auto ? prefixed.forced : undefined,
            forcePlan,
            planApproval: approval,
            updatePlan: rt.flags.loop.plan,
            verifyCommand: rt.flags.loop.verify ? rt.verify(projectRoot)?.command : undefined,
            skipVerify: loopHelpers!.explicitlySkipsVerify(prompt) || isQa,
          })

      if (msg.model.providerID !== EZK.providerID) {
        rt.autoSessions.delete(sessionID)
        rt.pinnedSessions.delete(sessionID)
        return
      }

      if (auto && rt.flags.loop.leadWorker) {
        const directive = /^\s*\/(pin|unpin)\b/i.exec(prompt)
        if (directive) {
          const commandText = textParts[0]?.text ?? ""
          const command = /^\s*\/(pin|unpin)\b/i.exec(commandText)
          const fallbackText = directive[1]!.toLowerCase() === "pin"
            ? "Keep the current model for this session."
            : "Resume automatic routing."
          const remainder = command ? commandText.slice(command[0].length).trimStart() : ""
          if (textParts[0] && command) textParts[0].text = remainder || fallbackText
          prompt = prompt.slice(directive[0].length).trimStart() || fallbackText
          prefixed = parseTierPrefix(prompt)
          if (directive[1]!.toLowerCase() === "unpin") rt.pinnedSessions.delete(sessionID)
          else {
            await restoreSessionCosts(rt, sessionID)
            await rt.ensureAllowed()
            const pinned = rt.engine.session(sessionID).lastModel ?? pickDefaultModel([...rt.engine.allowed.ids]) ?? EZK.fallbackModels[0]!
            rt.pinnedSessions.set(sessionID, pinned)
            msg.model = { providerID: EZK.providerID, modelID: pinned } as typeof msg.model
            rt.autoSessions.delete(sessionID)
            const route: RouteInfo = { mode: "pinned", model: pinned, reason: "pinned by /pin", at: Date.now() }
            rt.turns.set(sessionID, messageID, route)
            rt.log.write({ ts: Date.now(), session: sessionID, model: pinned, reason: route.reason, event: "decision" })
            return
          }
        }
        const pinned = rt.pinnedSessions.get(sessionID)
        if (pinned) {
          msg.model = { providerID: EZK.providerID, modelID: pinned } as typeof msg.model
          rt.autoSessions.delete(sessionID)
          const route: RouteInfo = { mode: "pinned", model: pinned, reason: "pinned for this session; use /unpin to resume routing", at: Date.now() }
          rt.turns.set(sessionID, messageID, route)
          return
        }
      }

      if (!rt.flags.router.enabled || picked !== EZK_AUTO_MODEL_ID) {
        rt.autoSessions.delete(sessionID)
        rt.pinnedSessions.delete(sessionID)
        await restoreSessionCosts(rt, sessionID)
        // The user chose a concrete model or a gateway alias: the router stands down.
        const prev = rt.flags.router.enabled ? rt.engine.session(sessionID).lastModel : undefined
        const route: RouteInfo = {
          mode: isAlias(picked) ? "alias" : "pinned",
          model: picked,
          reason: isAlias(picked) ? "gateway alias: the gateway picks the model" : "pinned by you",
          at: Date.now(),
        }
        if (rt.flags.router.enabled) rt.turns.set(sessionID, messageID, route)
        if (rt.flags.router.enabled && prev && prev !== picked) {
          rt.log.write({ ts: Date.now(), session: sessionID, model: picked, reason: route.reason, override: picked, event: "decision" })
        }
        if (rt.flags.router.enabled) rt.engine.session(sessionID).lastModel = undefined // next auto decision starts fresh
        return
      }

      rt.autoSessions.add(sessionID)
      await restoreSessionCosts(rt, sessionID)
      await rt.ensureAllowed()
      const signals = {
        prompt,
        hasImages: out.parts.some((p: any) => p.type === "file" && String(p.mime).startsWith("image/")),
        planMode: msg.agent === "plan",
        ...rt.signals.snapshot(sessionID),
      }

      let tiny: "heavy" | "light" | undefined
      if (rt.flags.router.tiny && !prefixed.forced && classify(signals).ambiguous) tiny = await tinyVerdict(prompt)

      const forcedTier = prefixed.forced ?? (rt.flags.loop.leadWorker || rt.flags.loop.plan ? loopDecision?.tier : undefined)
      const decision = rt.engine.decide(sessionID, messageID, signals, {
        forced: forcedTier,
        tiny,
        reason: !prefixed.forced && (rt.flags.loop.leadWorker || rt.flags.loop.plan) && loopDecision?.tier ? `${loopDecision.tier} (${loopDecision.reason})` : undefined,
      })
      let route: RouteInfo
      if (isError(decision)) {
        // Nothing routable by policy: use the normal default for this key (never fail the turn because of the router).
        const fallback = pickDefaultModel([...rt.engine.allowed.ids]) ?? EZK.fallbackModels[0]!
        route = { mode: "auto", model: fallback, reason: `router fallback: ${decision.error}`, at: Date.now() }
      } else route = decision

      msg.model = { providerID: EZK.providerID, modelID: route.model } as typeof msg.model
      remember(messageID)
      rt.turns.set(sessionID, messageID, route)
      const c = classify(signals)
      rt.log.write({
        ts: Date.now(),
        session: sessionID,
        tier: route.tier,
        score: c.score,
        model: route.model,
        reason: route.reason,
        promptChars: prompt.length,
        prompt,
        event: "decision",
      })
    },

    async "chat.headers"(input, out) {
      if (rt.autoMessages.has(input.message.id) || rt.autoSessions.has(input.sessionID)) {
        out.headers[H_SESSION] = input.sessionID
        out.headers[H_MESSAGE] = input.message.id
      }
    },

    async "experimental.model.select"(input, out) {
      const auto = rt.autoMessages.has(input.user.id) || rt.autoSessions.has(input.sessionID)
      if (!auto) return
      const latestUser = input.messages.findLast((item: any) => item.info?.role === "user")
      const userText = (latestUser?.parts ?? [])
        .filter((part: any) => part.type === "text" && !part.ignored)
        .map((part: any) => part.text)
        .join("\n")
      if (rt.flags.loop.phaseReasoning) {
        const phase = loopHelpers!.phaseFor({ prompt: userText, planMode: input.user.agent === "plan", messages: input.messages as any })
        out.variant = loopHelpers!.reasoningEffort(phase)
      }
      if (!rt.flags.router.enabled || !rt.autoSessions.has(input.sessionID)) return
      const sess = rt.engine.session(input.sessionID)
      if (rt.engine.capReached(input.sessionID)) {
        const cheap = rt.engine.capFallback()
        if (cheap) {
          out.model = { providerID: EZK.providerID, modelID: cheap }
          rt.turns.update(input.user.id, { model: cheap, downgraded: true, reason: `session cap $${rt.engine.capUSD} reached => ${cheap}` })
          return
        }
      }
      const esc = rt.engine.escalate(input.sessionID, rt.signals.snapshot(input.sessionID))
      if (esc) {
        rt.turns.update(input.user.id, { model: esc.model, tier: esc.tier, reason: esc.reason, escalatedFrom: esc.escalatedFrom })
        rt.log.write({ ts: Date.now(), session: input.sessionID, tier: "heavy", model: esc.model, reason: esc.reason, event: "escalation" })
      }
      if (sess.lastModel && sess.lastModel !== input.user.model.modelID) {
        out.model = { providerID: EZK.providerID, modelID: sess.lastModel }
      }
    },

    async "tool.execute.after"(input, out) {
      rt.signals.toolDone(input.sessionID, input.tool, input.args, out?.metadata)
      if (trackLoop) {
        const verifyFailed = rt.flags.loop.verify
          ? loopState!.finishVerify(input.sessionID, input.callID, {
              exit: typeof out?.metadata?.exit === "number" ? out.metadata.exit : undefined,
              output: typeof out?.output === "string" ? out.output : undefined,
            })
          : undefined
        loopState!.recordOutcome(input.sessionID, input.callID, {
          failed: verifyFailed ?? (typeof out?.metadata?.exit === "number" && out.metadata.exit !== 0),
        })
      }
    },

    async "tool.execute.before"(input, out) {
      if (!trackLoop) return
      loopState!.recordCall(input.sessionID, input.callID, input.tool, out?.args)
      const args = (out?.args ?? {}) as Record<string, unknown>
      if (
        rt.flags.loop.verify &&
        ["bash", "shell"].includes(input.tool.toLowerCase()) &&
        typeof args.command === "string" &&
        loopState!.beginVerify(input.sessionID, input.callID, args.command)
      ) {
        args.timeout = 120_000
      }
    },

    async "experimental.chat.messages.transform"(_input, out) {
      if (!rt.flags.loop.guard && !rt.flags.loop.plan && !rt.flags.loop.verify) return
      const source = out.messages.findLast((item: any) => item.info?.role === "user") as any
      if (!source) return
      if (rt.flags.loop.plan) {
        const prompt = source.parts
          .filter((part: any) => part.type === "text" && !part.synthetic && !part.ignored)
          .map((part: any) => part.text)
          .join("\n")
        loopState!.phaseChanged(source.info.sessionID, loopHelpers!.phaseFor({
          prompt,
          planMode: source.info.agent === "plan",
          messages: out.messages as unknown as LoopMessage[],
        }))
      }
      const sid = source.info.sessionID as string
      const sent = sentReminders.get(sid)
      if (sent) {
        for (const item of sent) {
          const at = out.messages.findIndex((m: any) => m.info?.id === item.anchorID)
          if (at >= 0) out.messages.splice(at + 1, 0, item.message)
        }
      }
      const reminder = loopState!.takeReminder(sid)
      if (!reminder) return
      const anchorID = (out.messages.at(-1) as any)?.info?.id as string | undefined
      const now = Date.now()
      const messageID = `msg${now}${Math.random().toString(36).slice(2, 10)}`
      const message = {
        info: { ...source.info, id: messageID, time: { created: now } },
        parts: [{
          id: `prt${now}${Math.random().toString(36).slice(2, 10)}`,
          messageID,
          sessionID: source.info.sessionID,
          type: "text" as const,
          text: `<system-reminder>${reminder.text}${reminder.askUser ? " Ask the user how they want to proceed before continuing." : ""}</system-reminder>`,
          synthetic: true,
        }],
      }
      out.messages.push(message)
      if (anchorID) {
        const list = [...(sentReminders.get(sid) ?? []), { anchorID, message }]
        sentReminders.set(sid, list.slice(-MAX_SENT_REMINDERS))
      }
    },

    async event({ event }) {
      const e = event as any
      if (e.type === "message.updated") {
        const info = e.properties?.info
        if (info?.role === "assistant" && info.time?.completed && info.tokens && info.providerID === EZK.providerID) {
          const usd = costUSD(rt.prices.get(info.modelID), info.tokens)
          rt.engine.setMessageCost(info.sessionID, info.id, usd)
          rt.costs.setMessageCost(info.sessionID, info.id, usd)
          rt.engine.setContextTokens(info.sessionID, (info.tokens.input ?? 0) + (info.tokens.cache?.read ?? 0))
        }
      } else if (e.type === "message.part.updated") {
        const part = e.properties?.part
        if (part?.type === "tool" && part.state?.status === "error" && !seenToolErrors.has(part.id)) {
          seenToolErrors.add(part.id)
          if (seenToolErrors.size > MAX_TRACKED) seenToolErrors.delete(seenToolErrors.values().next().value!)
          rt.signals.toolError(part.sessionID)
          if (trackLoop) loopState!.recordOutcome(part.sessionID, part.callID, { failed: true })
        }
      } else if (e.type === "session.deleted") {
        const id = e.properties?.info?.id ?? e.properties?.sessionID
        if (id) {
          rt.engine.forget(id)
          rt.signals.forget(id)
          if (trackLoop) loopState!.forget(id)
          sentReminders.delete(id)
          rt.costsLoaded.delete(id)
          rt.autoSessions.delete(id)
          rt.pinnedSessions.delete(id)
          if (execEnabled("diagnostics")) (await import("@/ezk/diag")).forgetRequest(id) // /context data of the deleted session
        }
      }
    },
  }

  async function tinyVerdict(prompt: string) {
    const model = rt.engine.policy.review.find((m) => rt.engine.allowed.ids.has(m))
    const key = rt.key()
    if (!model || !key) return undefined
    return tinyClassify(prompt, async (system, user, signal) => {
      const res = await fetch(`${rt.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 3, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        signal,
      })
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      return json.choices?.[0]?.message?.content ?? ""
    })
  }
}

function planApprovalEnabled(flags: ReturnType<typeof ezkRuntime>["flags"], directory: string, trusted: boolean) {
  const runtime = (flags as typeof flags & { planApproval?: { enabled?: boolean } }).planApproval?.enabled
  const configured = trusted ? readEzkConfig(directory).planApproval : undefined
  const project = configured && typeof configured === "object" && typeof (configured as Record<string, unknown>).enabled === "boolean"
    ? (configured as { enabled: boolean }).enabled
    : undefined
  const override = process.env.EZK_FEATURES?.split(",").map((item) => item.trim()).filter((item) => item.replace(/^[+-]/, "") === "planApproval").at(-1)
  if (override) return !override.startsWith("-")
  return project ?? runtime ?? false
}
