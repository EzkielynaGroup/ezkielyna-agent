// Ezkielyna exec lane (U4): data behind /context, /usage and the status line. The LLM layer records the last request
// per session (one call in session/llm.ts); usage is read from the session's stored assistant messages.
import fs from "node:fs"
import { Database } from "@opencode-ai/core/database/database"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import { RequestLog, contextBreakdown, sizeRequest } from "@opencode-ai/core/ezk/diag/context"
import { type Step, usageReport } from "@opencode-ai/core/ezk/diag/usage"
import { costUSD } from "@opencode-ai/core/ezk/pricing"
import { FingerprintGuard } from "@opencode-ai/core/ezk/speed/fingerprint"

const requests = new RequestLog()
const guard = new FingerprintGuard()
const prefixChanged = new Map<string, boolean>()

type Recorded = {
  input: { system: string[]; model: { id: string; limit: { context: number } } }
  prepared: { system: string[]; tools: Record<string, unknown>; messages: unknown[] }
}

/** Called once per provider request. Keeps sizes only (never the messages or tool objects), so a long session does not pin them. */
export function recordRequest(sessionID: string, req: Recorded) {
  if (!execEnabled("diagnostics")) return
  requests.record(
    sessionID,
    sizeRequest({
      system: req.prepared.system,
      baseSystem: req.input.system,
      tools: req.prepared.tools,
      messages: req.prepared.messages,
      modelID: req.input.model.id,
      window: req.input.model.limit.context,
    }),
  )
  prefixChanged.set(sessionID, !!guard.observe(sessionID, { system: req.prepared.system, tools: req.prepared.tools as never }))
  while (prefixChanged.size > 64) prefixChanged.delete(prefixChanged.keys().next().value!)
}

/** session.deleted: drop everything kept for the session. */
export function forgetRequest(sessionID: string) {
  requests.forget(sessionID)
  prefixChanged.delete(sessionID)
  guard.forget(sessionID)
}

export async function contextFor(sessionID: string) {
  const request = requests.get(sessionID)
  if (!request) return undefined
  const { ezkRuntime } = await import("@/plugin/ezk/runtime")
  const memoryBlock = ezkRuntime().frozen.get(sessionID)
  const usage = usageReport(await steps(sessionID))
  return contextBreakdown({ ...request, memoryBlock }, usage.lastModelID === request.modelID ? usage.lastPromptTokens || undefined : undefined)
}

export async function usageFor(sessionID: string) {
  const report = usageReport(await steps(sessionID), { prefixChanged: prefixChanged.get(sessionID) })
  const window = requests.get(sessionID)?.window
  return { report, contextPct: window && report.lastPromptTokens ? Math.round((report.lastPromptTokens / window) * 1000) / 10 : undefined }
}

/** Completed assistant messages of a session, priced with the router's price book for gateway models. */
async function steps(sessionID: string): Promise<Step[]> {
  const file = Database.path()
  if (file === ":memory:" || !fs.existsSync(file)) return []
  const { ezkRuntime } = await import("@/plugin/ezk/runtime")
  const prices = ezkRuntime().prices
  const { openSqlite } = await import("@opencode-ai/core/ezk/search/sqlite")
  const db = await openSqlite(file, { readonly: true })
  try {
    return db
      .all<{ id: string; data: string }>("SELECT id, data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'", sessionID)
      .flatMap((row) => {
        const info = parse(row.data)
        if (!info?.time?.completed || !info.tokens) return []
        const cost = info.providerID === EZK.providerID ? costUSD(prices.get(info.modelID ?? ""), normalize(info.tokens)) : (info.cost ?? 0)
        return [
          {
            id: row.id,
            modelID: info.modelID ?? "",
            providerID: info.providerID ?? "",
            tokens: info.tokens,
            costUSD: cost,
            created: info.time.created ?? 0,
            completed: info.time.completed,
            summary: info.summary === true,
          },
        ]
      })
  } catch {
    return []
  } finally {
    db.close()
  }
}

type Info = {
  modelID?: string
  providerID?: string
  cost?: number
  summary?: boolean
  time?: { created?: number; completed?: number }
  tokens?: Step["tokens"]
}

function parse(text: string): Info | undefined {
  try {
    return JSON.parse(text) as Info
  } catch {
    return undefined
  }
}

function normalize(tokens: Step["tokens"]) {
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cache: { read: tokens.cache?.read ?? 0, write: tokens.cache?.write ?? 0 },
  }
}
