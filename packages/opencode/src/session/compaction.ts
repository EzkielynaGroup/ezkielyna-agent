import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { loadFlags } from "@opencode-ai/core/ezk/flags"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Instruction } from "./instruction"
import { Todo } from "./todo"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
const KEEP_TOOL_OUTPUT_TOKENS = 40_000
const MINIMUM_TOOL_OUTPUT_CLEAR_TOKENS = 20_000
const TOOL_OUTPUT_MAX_TOKENS = 5_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const truncateTokens = (value: string, maxTokens: number) => {
  if (Token.estimate(value) <= maxTokens) return value
  let end = Math.min(value.length, maxTokens * 4)
  const marker = `\n[truncated to ${maxTokens} tokens]`
  while (end > 0 && Token.estimate(value.slice(0, end) + marker) > maxTokens) end = Math.floor(end * 0.9)
  return `${value.slice(0, end)}${marker}`
}

function loadedReadPaths(messages: SessionV1.WithParts[]) {
  const out: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "read" || part.state.status !== "completed")
        continue
      const filepath = part.state.input?.filePath
      if (typeof filepath === "string") out.push(filepath)
      const loaded = part.state.metadata?.loaded
      if (!Array.isArray(loaded)) continue
      for (const filepath of loaded) if (typeof filepath === "string") out.push(filepath)
    }
  }
  return [...new Set(out.reverse())].slice(0, 5).reverse()
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

/** User text for the summary input. With `clean`, synthetic parts and <system-reminder> blocks (volatile, per-turn) are dropped. */
const userText = (message: SessionV1.WithParts, clean: boolean) =>
  message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored && !(clean && part.synthetic))
    .map((part) => (clean ? part.text.replace(REMINDER, "").trim() : part.text))
    .filter(Boolean)
    .join("\n")

const serialize = (message: SessionV1.WithParts, clean = false) => {
  if (message.info.role === "user") {
    const text = userText(message, clean)
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? (part.state.output.startsWith("[output dibuang saat ringkasan:") ? part.state.output : "[Old tool result content cleared]")
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  /** True when the breaker has stopped AUTOMATIC compaction for this session (warns once). The turn must still go on. */
  readonly autoPaused: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
    focus?: string
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const instructions = yield* Instruction.Service
    const todos = yield* Todo.Service
    const fsys = yield* FSUtil.Service
    const compactionEnabled = loadFlags([Global.Path.config]).compaction.enabled
    const compactionHelpers = compactionEnabled
      ? yield* Effect.promise(() => import("@opencode-ai/core/ezk/compaction"))
      : undefined
    const breaker = compactionEnabled
      ? yield* Effect.promise(async () => {
          const [{ ezkPaths }, { CompactionStateStore }, path] = await Promise.all([
            import("@opencode-ai/core/ezk/wipe"),
            import("@/ezk/compaction-state"),
            import("node:path"),
          ])
          const paths = ezkPaths({ config: Global.Path.config, data: Global.Path.data })
          return new CompactionStateStore(path.join(paths.ezkDataDir, "compaction-breaker.json"))
        })
      : undefined
    const pendingFocus = new Map<SessionID, string>()

    const warning = Effect.fn("SessionCompaction.warning")(function* (sessionID: SessionID, message: string) {
      yield* events.publish(Session.Event.Error, {
        sessionID,
        error: new SessionV1.ContextOverflowError({ message }).toObject(),
      })
    })

    const warnedPaused = new Set<string>()
    const autoPaused = Effect.fn("SessionCompaction.autoPaused")(function* (sessionID: SessionID) {
      if (!compactionEnabled || !breaker!.blocked(sessionID)) return false
      if (!warnedPaused.has(sessionID)) {
        warnedPaused.add(sessionID)
        yield* warning(sessionID, "Automatic compaction is paused for this session (three attempts did not shrink it by 20%). Your message is still answered; use /handoff to continue in a fresh session, or /compact with a focus.")
      }
      return true
    })

    const clearOldResults = Effect.fn("SessionCompaction.clearOldResults")(function* (input: { sessionID: SessionID }) {
      const messages = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.catch(() => Effect.succeed([])))
      let newerUserTurns = 0
      const items: SessionV1.ToolPart[] = []
      const eligible = new Set<string>()
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!
        if (message.info.role === "user" && !message.parts.some((part) => part.type === "compaction")) newerUserTurns++
        if (newerUserTurns < 2) continue
        eligible.add(message.info.id)
      }
      for (const message of messages) {
        if (!eligible.has(message.info.id)) continue
        for (const part of message.parts) if (part.type === "tool" && part.state.status === "completed") items.push(part)
      }
      const result = compactionHelpers!.clearOldToolResults({
        items,
        output: (part) => part.state.status === "completed" ? part.state.output : "",
        replace: (part, marker) => part.state.status !== "completed" ? part : {
          ...part,
          state: { ...part.state, output: marker, time: { ...part.state.time, compacted: Date.now() } },
        },
        protected: (part) => part.tool === "skill" || (part.state.status === "completed" && !!part.state.time.compacted),
        keepTokens: KEEP_TOOL_OUTPUT_TOKENS,
        minimumFreedTokens: MINIMUM_TOOL_OUTPUT_CLEAR_TOKENS,
        estimate: Token.estimate,
      })
      if (!result.cleared) return 0
      for (let i = 0; i < result.items.length; i++) {
        if (result.items[i] !== items[i]) yield* session.updatePart(result.items[i]!)
      }
      yield* Effect.logInfo("cleared old tool outputs", { count: result.cleared, tokens: result.freedTokens })
      return result.freedTokens
    })

    const restorationContext = Effect.fn("SessionCompaction.restorationContext")(function* (input: {
      sessionID: SessionID
      messages: SessionV1.WithParts[]
    }) {
      const context: string[] = []
      const instructionPaths = yield* instructions.systemPaths().pipe(Effect.catch(() => Effect.succeed(new Set<string>())))
      for (const filepath of instructionPaths) {
        const content = yield* fsys.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
        if (content) context.push(`Instruction file ${filepath}:\n${content}`)
      }
      const items = yield* todos.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed([])))
      if (items.length) {
        context.push(`Current TODOs:\n${items.map((item) => `- [${item.status}] (${item.priority}) ${item.content}`).join("\n")}`)
      }
      for (const filepath of loadedReadPaths(input.messages)) {
        const content = yield* fsys.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
        if (content) context.push(`Recently read file ${filepath}:\n${truncateTokens(content, TOOL_OUTPUT_MAX_TOKENS)}`)
      }
      return context
    })

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      const cfg = yield* config.get()
      if (compactionEnabled && input.model.providerID === EZK.providerID) {
        const { ezkRuntime } = yield* Effect.promise(() => import("@/plugin/ezk/runtime"))
        const rt = ezkRuntime()
        yield* Effect.promise(() => rt.ensureMetadata())
        const fallback = usable({ cfg, model: input.model, outputTokenMax: flags.outputTokenMax })
        const metadataWindow = rt.engine.policy.models[input.model.id]?.agentContext
        if (metadataWindow !== undefined) {
          if (cfg.compaction?.auto === false || input.model.limit.context === 0) return false
          const count =
            input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
          return count >= compactionHelpers!.modelCompactionThreshold(rt.engine.policy, input.model.id, fallback)
        }
      }
      return overflow({
        cfg,
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      let compactionMessages = input.messages
      if (compactionEnabled && input.auto && breaker!.blocked(input.sessionID)) {
        const task = compactionMessages.findLast((m) => m.info.id === input.parentID)
        if (task?.info.role === "user") yield* session.removeMessage({ sessionID: input.sessionID, messageID: task.info.id })
        yield* warning(
          input.sessionID,
          "Automatic compaction paused after three attempts failed to shrink this session by 20%. Use /compact with a focus, /handoff, or start a new session.",
        )
        return "stop"
      }
      if (compactionEnabled) {
        yield* clearOldResults({ sessionID: input.sessionID })
        compactionMessages = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.catch(() => Effect.succeed([])))
      }

      const parent = compactionMessages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      if (compactionEnabled && input.auto && !input.overflow) {
        const active = yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
        const cfg = yield* config.get()
        const { ezkRuntime } = yield* Effect.promise(() => import("@/plugin/ezk/runtime"))
        const rt = ezkRuntime()
        yield* Effect.promise(() => rt.ensureMetadata())
        const fallback = usable({ cfg, model: active, outputTokenMax: flags.outputTokenMax })
        const limit = userMessage.model.providerID === EZK.providerID
          ? compactionHelpers!.modelCompactionThreshold(rt.engine.policy, userMessage.model.modelID, fallback)
          : fallback
        const count = yield* estimate({ messages: compactionMessages.filter((m) => m.info.id !== input.parentID), model: active })
        // The trigger (prompt.ts) uses provider-reported tokens of the last finished assistant message, which include the
        // system prompt and tool schemas. Use that same quantity here, otherwise a skipped compaction wedges the session.
        const lastReported = compactionMessages.findLast(
          (m) => m.info.role === "assistant" && m.info.finish && m.info.summary !== true && m.info.id !== input.parentID,
        )
        const triggerOverflow =
          lastReported?.info.role === "assistant"
            ? yield* isOverflow({ tokens: lastReported.info.tokens, model: active })
            : false
        if (count < limit && !triggerOverflow) {
          yield* session.removeMessage({ sessionID: input.sessionID, messageID: parent.info.id })
          return "stop"
        }
      }

      let messages = compactionMessages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = compactionMessages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = compactionMessages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = compactionMessages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = compactionMessages
        }
      }

      const agent = yield* agents.get("compaction")
      let model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      if (compactionEnabled) {
        const { ezkRuntime } = yield* Effect.promise(() => import("@/plugin/ezk/runtime"))
        const rt = ezkRuntime()
        if (rt.key()) {
          yield* Effect.promise(() => rt.ensureAllowed()).pipe(Effect.catch(() => Effect.void))
          const { chainFor } = yield* Effect.promise(() => import("@opencode-ai/core/ezk/model-policy"))
          const flash = chainFor(rt.engine.policy, "light", rt.engine.allowed).find((id) => rt.engine.policy.flash.includes(id))
          if (flash) {
            model = yield* provider
              .getModel(ProviderV2.ID.make(EZK.providerID), ModelV2.ID.make(flash))
              .pipe(Effect.catch(() => Effect.succeed(model)))
          }
        }
      }
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const visibleHistory = history.filter((_, index) => !hidden.has(index))
      const selected = yield* select({
        messages: visibleHistory,
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const conversation = msgs.map((m) => serialize(m, compactionEnabled)).filter(Boolean).join("\n\n")
      const focus = pendingFocus.get(input.sessionID)
      pendingFocus.delete(input.sessionID)
      const restored = compactionEnabled
        ? yield* restorationContext({ sessionID: input.sessionID, messages: history })
        : []
      const latestUsers = compactionEnabled
        ? compactionHelpers!.recentUserMessages({
            messages: history,
            isUser: (message) => message.info.role === "user" && !message.parts.some((part) => part.type === "compaction"),
            text: (message) => userText(message, true),
            estimate: Token.estimate,
          }).map((message) => userText(message, true))
        : []
      const beforeTokens = compactionEnabled ? yield* estimate({ messages: history, model }) : 0
      const nextPrompt = compacting.prompt ?? (compactionEnabled
        ? compactionHelpers!.recipePrompt({
            conversation,
            focus,
            previousSummary,
            recentUsers: latestUsers,
            context: [...compacting.context, ...restored],
          })
        : [
            buildPrompt({
              previousSummary,
              context: [conversation],
            }),
            ...compacting.context,
          ]
            .filter(Boolean)
            .join("\n\n"))
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  nextPrompt,
                  ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        ],
        model,
      })
      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        if (compactionEnabled) {
          const state = yield* Effect.sync(() => breaker!.record(input.sessionID, {
            beforeTokens,
            afterTokens: beforeTokens,
            ineffective: true,
          })).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (state && state.failures >= 3) {
            yield* warning(
              input.sessionID,
              "Automatic compaction paused after three attempts failed to shrink this session by 20%. Use /compact with a focus, /handoff, or start a new session.",
            )
          }
        }
        return "stop"
      }

      if (compactionEnabled && result === "continue") {
        const start = selected.tail_start_id
          ? visibleHistory.findIndex((message) => message.info.id === selected.tail_start_id)
          : visibleHistory.length
        const retained = start >= 0 ? visibleHistory.slice(start) : []
        const completed = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.catch(() => Effect.succeed([])))
        const summary = completed.find((message) => message.info.id === processor.message.id)
        const afterTokens = Token.estimate(summary ? summaryText(summary) ?? "" : "") +
          (retained.length ? yield* estimate({ messages: retained, model }) : 0)
        const ineffective = compactionHelpers!.compactionIneffective(beforeTokens, afterTokens)
        const state = yield* Effect.sync(() => breaker!.record(input.sessionID, {
          beforeTokens,
          afterTokens,
          ineffective,
        })).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (input.auto && state && state.failures >= 3) {
          yield* warning(
            input.sessionID,
            "Automatic compaction paused after three attempts failed to shrink this session by 20%. Use /compact with a focus, /handoff, or start a new session.",
          )
        }
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
      focus?: string
    }) {
      if (compactionEnabled && input.focus?.trim()) pendingFocus.set(input.sessionID, input.focus.trim())
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      autoPaused,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Instruction.node,
    Todo.node,
    FSUtil.node,
  ],
})

export * as SessionCompaction from "./compaction"
