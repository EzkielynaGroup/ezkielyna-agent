// Ezkielyna Agent v1.1: process-wide runtime of the ezk features (router now, memory/search next).
// One instance per process (the gateway key, the model list and the circuit breaker are global, not per project).
import path from "node:path"
import fs from "node:fs"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { listModels } from "@opencode-ai/core/ezkielyna"
import { type EzkFlags, loadFlags } from "@opencode-ai/core/ezk/flags"
import { loadPolicy, DEFAULT_POLICY } from "@opencode-ai/core/ezk/model-policy"
import { PriceBook, costUSD, loadPricing } from "@opencode-ai/core/ezk/pricing"
import { readGatewayKey } from "@opencode-ai/core/ezk/key"
import { RouterEngine } from "@opencode-ai/core/ezk/router/engine"
import { RouterLog } from "@opencode-ai/core/ezk/router/log"
import { RouteTurns } from "@opencode-ai/core/ezk/router/turns"
import { SessionSignals } from "@opencode-ai/core/ezk/router/signals"
import { ProCapability } from "@opencode-ai/core/ezk/router/capability"
import { routedFetch } from "@opencode-ai/core/ezk/router/fetch"
import { MemoryStore } from "@opencode-ai/core/ezk/memory/store"
import { StateFile } from "@opencode-ai/core/ezk/memory/state"
import { reviewGate } from "./review-gate"
import { ezkPaths } from "@opencode-ai/core/ezk/wipe"
import { SessionCosts } from "@opencode-ai/core/ezk/router/costs"
import { detectVerify, type Verify } from "@opencode-ai/core/ezk/context/verify"
import type { LoopPolicy } from "@opencode-ai/core/ezk/loop/policy"

const ALLOWED_TTL_MS = 10 * 60_000
export { reviewGate }

export interface EzkRuntime {
  flags: EzkFlags
  engine: RouterEngine
  prices: PriceBook
  turns: RouteTurns
  log: RouterLog
  signals: SessionSignals
  pro: ProCapability
  /** user message ids whose model the router chose (the routed fetch only reroutes these) */
  autoMessages: Set<string>
  /** sessions whose current model choice is Auto; internal reminder turns inherit the routing decision */
  autoSessions: Set<string>
  pinnedSessions: Map<string, string>
  /** memory (track M): files under <config>/memory, frozen per-session blocks, reviewer bookkeeping */
  memory: MemoryStore
  memState: StateFile
  frozen: Map<string, string>
  reviewTurns: Map<string, number>
  reviewExplicit: Set<string>
  costsLoaded: Set<string>
  costs: SessionCosts
  loop(): Promise<LoopPolicy>
  /** Project verify command for the opt-in loop.verify gate. */
  verify(dir: string): Verify | undefined
  lastReview?: { at: number; applied: number; rejected: string[]; model?: string; tokens?: number; error?: string }
  baseURL: string
  key(): string | undefined
  ensureMetadata(): Promise<void>
  ensureAllowed(): Promise<void>
}

let runtime: EzkRuntime | undefined
let metadataLoading: Promise<void> | undefined

export function ezkRuntime(): EzkRuntime {
  if (runtime) return runtime
  const flags = loadFlags([Global.Path.config])
  const prices = new PriceBook()
  let pro: ProCapability
  const engine = new RouterEngine({ policy: DEFAULT_POLICY, prices, flags: flags.router, proEnabled: () => pro.visible() })
  pro = new ProCapability(engine, () => flags.router.claude)
  const baseURL = EZK.baseURL
  const paths = ezkPaths({ config: Global.Path.config, data: Global.Path.data })
  const turns = new RouteTurns(Global.Path.data)
  const log = new RouterLog(Global.Path.data, {
    enabled: flags.router.log || flags.loop.leadWorker,
    prompts: flags.router.logPrompts,
  })
  const key = () => readGatewayKey(Global.Path.data)

  let allowedAt = 0
  let inflight: Promise<void> | undefined
  let loopLoading: Promise<LoopPolicy> | undefined
  const ensureMetadata = () => {
    metadataLoading ??= Promise.all([
      loadPolicy({
        configDir: Global.Path.config,
        cacheDir: Global.Path.cache,
        policyURL: flags.router.policyURL,
      }).then((policy) => engine.setPolicy(policy)),
      loadPricing({ baseURL, cacheDir: Global.Path.cache }).then((table) => prices.set(table)),
    ]).then(() => undefined)
    return metadataLoading
  }
  const refresh = async () => {
    await ensureMetadata()
    const res = await listModels({ key: key(), baseURL, cacheDir: Global.Path.cache })
    engine.setAllowed(res.ids)
    allowedAt = Date.now()
  }
  const ensureAllowed = async () => {
    await ensureMetadata()
    if (engine.allowed.ids.size && Date.now() - allowedAt < ALLOWED_TTL_MS) return
    if (!engine.allowed.ids.size) {
      inflight ??= refresh().finally(() => (inflight = undefined))
      return inflight
    }
    void (inflight ??= refresh().finally(() => (inflight = undefined))) // stale: refresh in the background
  }

  runtime = {
    flags,
    engine,
    prices,
    turns,
    log,
    signals: new SessionSignals(),
    pro,
    autoMessages: new Set(),
    autoSessions: new Set(),
    pinnedSessions: new Map(),
    memory: new MemoryStore(paths.memoryDir),
    memState: new StateFile(paths.memoryDir),
    frozen: new Map(),
    reviewTurns: new Map(),
    reviewExplicit: new Set(),
    costsLoaded: new Set(),
    costs: new SessionCosts(path.join(paths.ezkDataDir, "session-costs.jsonl")),
    loop: () => loopLoading ??= import("@opencode-ai/core/ezk/loop/policy").then(({ LoopPolicy }) => new LoopPolicy()),
    verify: detectVerify,
    baseURL,
    key,
    ensureMetadata,
    ensureAllowed,
  }
  return runtime
}

/** Test hook: drop the singleton. */
export function resetEzkRuntime() {
  runtime = undefined
  metadataLoading = undefined
}

/** Restore a session's recorded spend once, using the durable ledger and completed assistant rows in the session database. */
export async function restoreSessionCosts(rt: EzkRuntime, sessionID: string) {
  if (rt.costsLoaded.has(sessionID)) return
  const costs = new Map(rt.costs.forSession(sessionID))
  const file = Database.path()
  if (file !== ":memory:" && fs.existsSync(file)) {
    try {
      const { openSqlite } = await import("@opencode-ai/core/ezk/search/sqlite")
      const src = await openSqlite(file, { readonly: true })
      try {
        const rows = src.all<{ id: string; data: string }>(
          "SELECT id, data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'",
          sessionID,
        )
        for (const row of rows) {
          try {
            const info = JSON.parse(row.data) as {
              role?: string
              providerID?: string
              modelID?: string
              time?: { completed?: number }
              cost?: number
              tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
            }
            if (info.role !== "assistant" || !info.time?.completed || info.providerID !== EZK.providerID || !info.tokens) continue
            const model = info.modelID
            const usd = typeof info.cost === "number" && Number.isFinite(info.cost) && info.cost >= 0
              ? info.cost
              : model
                ? costUSD(rt.prices.get(model), info.tokens)
                : 0
            costs.set(row.id, usd)
          } catch {}
        }
      } finally {
        src.close()
      }
    } catch {}
  }
  for (const [messageID, usd] of costs) {
    rt.engine.setMessageCost(sessionID, messageID, usd)
    rt.costs.setMessageCost(sessionID, messageID, usd)
  }
  rt.costsLoaded.add(sessionID)
}

let installed = false
/** Patch globalThis.fetch once so gateway chat calls go through the routed fetch (works for env keys and auth.json). */
export function installRoutedFetch(rt: EzkRuntime) {
  if (installed) return
  installed = true
  const original = globalThis.fetch
  const wrapped = routedFetch({
    engine: rt.engine,
    baseURL: rt.baseURL,
    base: original,
    onSwitch(e) {
      if (e.messageID) rt.turns.update(e.messageID, { model: e.to, fallbackFrom: e.from, fallbackReason: e.reason })
      rt.log.write({ ts: Date.now(), session: e.sessionID, model: e.to, reason: `fallback from ${e.from}: ${e.reason}`, event: "fallback" })
    },
  })
  ;(wrapped as any).preconnect = (original as any).preconnect?.bind(original)
  globalThis.fetch = wrapped
}

export const dataPath = (...p: string[]) => path.join(Global.Path.data, "ezk", ...p)
