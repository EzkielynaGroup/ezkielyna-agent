// X1 `ezkielyna exec` runtime: drives one in-process session through the local server API (the same path as `run`),
// maps bus events to Codex events, answers permission requests by mode, and enforces --max-turns / --max-budget.
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { type CodexEvent, CodexEventMapper } from "@opencode-ai/core/ezk/exec/codex-events"
import { type PermissionMode, type RunOutcome, decidePermission, exitCode, schemaInstruction, schemaRetryPrompt } from "@opencode-ai/core/ezk/exec/headless"
import { checkOutput } from "@opencode-ai/core/ezk/exec/schema-check"
import { costUSD } from "@opencode-ai/core/ezk/pricing"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { isProtectedRelative } from "@opencode-ai/core/ezk/safety/protected-paths"
import { projectTrusted } from "@/config/trust"
import { warnUntrustedMode } from "./trust-notice"
import { type Prices, normalize, routerPrices } from "./usage-line"

export type ExecInput = {
  prompt: string
  /** project folder; sent with every request so the session never falls back to the caller's folder */
  directory: string
  json: boolean
  schema?: unknown
  lastMessageFile?: string
  maxTurns?: number
  maxBudgetUSD?: number
  mode: PermissionMode
  resume?: string
  model?: string
  agent?: string
  variant?: string
  /** Internal override for program-created, isolated hard-mode worktrees only. */
  trusted?: boolean
  signal?: AbortSignal
  onMetrics?: (metrics: { costUSD: number; turns: number; limit?: "turns" | "budget" }) => void
  write: (line: string) => void
  log: (line: string) => void
  /** test hook: an SDK client instead of the in-process server */
  sdk?: OpencodeClient
}

/** after the prompt call returns, wait this long at most for the trailing idle event */
const DRAIN_MS = 5_000

export async function runExec(input: ExecInput): Promise<number> {
  const sdk = input.sdk ?? (await localClient(input.directory))
  const outcome: RunOutcome = { errors: 0, denied: 0 }
  const sessionID = await openSession(sdk, input)
  if (!sessionID) {
    const message = input.resume ? `Session not found: ${input.resume}` : "Could not create a session"
    emit(input, { type: "error", message })
    return 1
  }
  const mapper = new CodexEventMapper(sessionID)
  emit(input, mapper.threadStarted())

  // An untrusted folder never gets more than "ask" (the same rule as the app's permission modes): trust it with `ezkielyna trust`.
  const trusted = input.trusted ?? projectTrusted(input.directory)
  warnUntrustedMode({ mode: input.mode, trusted, log: input.log })
  const sessions = new Set([sessionID])
  const prices = await routerPrices()
  const collectMetrics = () => {
    const steps = mapper.completedSteps()
    return {
      costUSD: steps.reduce(
        (sum, step) => sum + (step.providerID === EZK.providerID ? costUSD(prices(step.modelID), normalize(step.tokens)) : step.cost),
        0,
      ),
      turns: steps.length,
      limit: outcome.limit,
    }
  }
  let turn: { busy: boolean; done: () => void } | undefined
  let stopping = false
  const eventController = new AbortController()
  const abortSession = () => void sdk.session.abort({ sessionID }).catch(() => {})
  const abortEvents = () => eventController.abort()
  if (input.signal) {
    input.signal.addEventListener("abort", abortSession, { once: true })
    input.signal.addEventListener("abort", abortEvents, { once: true })
    if (input.signal.aborted) {
      abortSession()
      abortEvents()
    }
  }
  const events = await sdk.event.subscribe(undefined, { signal: eventController.signal })
  const pump = (async () => {
    for await (const event of events.stream as AsyncIterable<{ type: string; properties: any }>) {
      const p = event.properties ?? {}
      if (event.type === "session.created" && p.info?.parentID && sessions.has(p.info.parentID)) sessions.add(p.info.id)
      mapper.map(event).forEach((out) => emit(input, out))
      if (event.type === "message.updated" && p.info?.sessionID === sessionID && p.info.role === "assistant" && p.info.time?.completed && !stopping) {
        const limit = overLimit(input, mapper, prices, p.info.finish)
        if (limit) {
          stopping = true
          outcome.limit = limit
          void sdk.session.abort({ sessionID }).catch(() => {})
        }
        input.onMetrics?.(collectMetrics())
      }
      if (event.type === "permission.asked" && sessions.has(p.sessionID)) {
        const reply = decidePermission(input.mode, p.permission, { patterns: p.patterns, trusted, root: input.directory })
        if (reply === "reject") {
          outcome.denied++
          if (!input.json) input.log(`! denied ${p.permission} (${(p.patterns ?? []).join(", ")}) by --permission-mode ${input.mode}${denialNote(input.mode, p.permission, p.patterns, trusted)}`)
        }
        await sdk.permission.reply({ requestID: p.id, reply }).catch(() => {})
      }
      if (event.type === "session.status" && p.sessionID === sessionID) {
        if (p.status?.type === "busy" && turn) turn.busy = true
        if (p.status?.type === "idle" && turn?.busy) turn.done()
      }
    }
  })().catch(() => {})

  const runTurn = async (text: string) => {
    const errorsBefore = mapper.errors.length
    emit(input, mapper.turnStarted())
    const idle = new Promise<void>((resolve) => (turn = { busy: false, done: resolve }))
    const result = await sdk.session.prompt({
      sessionID,
      agent: input.agent ?? (input.mode === "plan" ? "plan" : undefined),
      model: pickModel(input.model),
      variant: input.variant,
      parts: [{ type: "text", text }],
    })
    await Promise.race([idle, Bun.sleep(DRAIN_MS)])
    turn = undefined
    const failed = outcome.limit
      ? `stopped: ${outcome.limit === "turns" ? `--max-turns ${input.maxTurns} reached` : `--max-budget $${input.maxBudgetUSD} reached`}`
      : result.error
        ? errorMessage(result.error)
        : mapper.errors.length > errorsBefore
          ? mapper.errors.at(-1)
          : undefined
    if (failed) {
      if (!outcome.limit) outcome.errors++
      emit(input, mapper.turnFailed(failed))
      return false
    }
    emit(input, mapper.turnCompleted())
    return true
  }

  try {
    const ok = await runTurn(input.schema === undefined ? input.prompt : input.prompt + schemaInstruction(input.schema))
    let final = mapper.lastMessage
    if (ok && input.schema !== undefined) {
      const first = checkOutput(mapper.lastMessage, input.schema)
      const second = first.ok ? first : (await runTurn(schemaRetryPrompt(first.errors))) ? checkOutput(mapper.lastMessage, input.schema) : first
      if (second.ok) final = JSON.stringify(second.value)
      else {
        outcome.schemaFailed = true
        emit(input, { type: "error", message: `final message does not match --output-schema: ${second.errors.slice(0, 5).join("; ")}` })
      }
    }

    if (input.lastMessageFile) {
      await fs.mkdir(path.dirname(path.resolve(input.lastMessageFile)), { recursive: true })
      await fs.writeFile(input.lastMessageFile, final)
    }
    if (!input.json && final) input.write(final)
    input.onMetrics?.(collectMetrics())
    return exitCode(outcome)
  } finally {
    eventController.abort()
    input.signal?.removeEventListener("abort", abortSession)
    input.signal?.removeEventListener("abort", abortEvents)
    await pump
  }
}

function denialNote(mode: string, permission: string, patterns: readonly string[] | undefined, trusted: boolean) {
  if (mode !== "ask" && !trusted) return " (folder not trusted)"
  if (permission === "edit" && (patterns ?? []).some((pattern) => isProtectedRelative(pattern))) return " (protected path)"
  if (permission === "bash") return mode === "ask" ? "" : " (or the command mentions a protected path)"
  return ""
}

function emit(input: ExecInput, event: CodexEvent) {
  if (input.json) return input.write(JSON.stringify(event))
  if (event.type === "item.started" && event.item.type === "command_execution") return input.log(`$ ${event.item.command}`)
  if (event.type === "item.completed" && event.item.type === "file_change")
    return event.item.changes.forEach((change) => input.log(`${change.kind === "add" ? "+" : change.kind === "delete" ? "-" : "~"} ${change.path}`))
  if (event.type === "item.completed" && event.item.type === "error") return input.log(`error: ${event.item.message}`)
  if (event.type === "error") return input.log(`error: ${event.message}`)
  if (event.type === "turn.failed") return input.log(`failed: ${event.error.message}`)
}

/** --max-turns counts model turns (one per provider call); a turn that ended with a final answer never trips it. */
function overLimit(input: ExecInput, mapper: CodexEventMapper, prices: Prices, finish: string | undefined) {
  if (finish !== "tool-calls" && finish !== "unknown") return undefined
  const steps = mapper.completedSteps()
  if (input.maxTurns && steps.length >= input.maxTurns) return "turns" as const
  const spent = steps.reduce((sum, s) => sum + (s.providerID === EZK.providerID ? costUSD(prices(s.modelID), normalize(s.tokens)) : s.cost), 0)
  if (input.maxBudgetUSD && spent >= input.maxBudgetUSD) return "budget" as const
  return undefined
}

async function openSession(sdk: OpencodeClient, input: ExecInput) {
  if (input.resume) {
    const found = await sdk.session.get({ sessionID: input.resume }).catch(() => undefined)
    return found?.data?.id
  }
  const created = await sdk.session.create({
    title: input.prompt.slice(0, 50) + (input.prompt.length > 50 ? "..." : ""),
    permission: ["question", "plan_enter", "plan_exit"].map((permission) => ({ permission, action: "deny" as const, pattern: "*" })),
  })
  return created.data?.id
}

function pickModel(value: string | undefined) {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return { providerID: providerID!, modelID: rest.join("/") }
}

function errorMessage(error: unknown) {
  const e = error as { data?: { message?: string }; message?: string; name?: string }
  return String(e?.data?.message ?? e?.message ?? e?.name ?? "request failed")
}

async function localClient(directory: string) {
  const { Server } = await import("@/server/server")
  const { ServerAuth } = await import("@/server/auth")
  const fetchFn = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(request, init)
    const headers = new Headers(req.headers)
    const auth = ServerAuth.header()
    if (auth) headers.set("Authorization", auth)
    return Server.Default().app.fetch(new Request(req, { headers }))
  }) as typeof globalThis.fetch
  return createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn, directory })
}
