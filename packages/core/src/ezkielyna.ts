// Ezkielyna Agent: brand constants, default provider and model discovery.
//
// This file is intentionally self-contained so that the rebrand stays a small, mergeable diff against upstream
// Ezkielyna Agent (MIT). Everything Ezkielyna-specific that is not a pure rename lives here or in
// packages/opencode/src/plugin/ezkielyna.ts.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { EZK } from "./ezkielyna-brand"
import type { ModelMetadata } from "./ezk/model-policy"
import { perMtok, STATIC_PRICES, type Price } from "./ezk/pricing"

export { EZK }

/** Ids returned by /v1/models that are not chat models (embeddings, rerankers, speech, media). */
const NON_CHAT =
  /(embed|^bge-|rerank|^voyage-|tts|whisper|^dall-e|image|video|seedance|sora|imagen|midjourney|suno|nano-banana|veo-|moderation|-ocr$)/i

export function isChatModel(id: string) {
  return !NON_CHAT.test(id)
}

/**
 * Pick the model to start with. `allowed` is the key's /v1/models list (already filtered to chat models).
 * Preferred model first, then the Flash-plan fallbacks, then simply the first allowed model.
 */
export function pickDefaultModel(allowed: string[]): string | undefined {
  for (const id of [EZK.defaultModel, ...EZK.defaultModelFallbacks]) if (allowed.includes(id)) return id
  return allowed[0]
}

/** Model for titles/summaries: the cheapest alias the key can use, else the normal default. */
export function pickSmallModel(allowed: string[]): string | undefined {
  for (const id of EZK.smallModelPreference) if (allowed.includes(id)) return id
  return pickDefaultModel(allowed)
}

function prettyName(id: string) {
  return id
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
}

function modelEntry(id: string, metadata: ModelMetadata = {}, prices: Record<string, Price> = STATIC_PRICES) {
  const deepseek = id.startsWith("deepseek")
  const reasoning = metadata.reasoning === true || metadata.effort === true
  const reasoningOptions = reasoning
    ? metadata.effort === true
      ? [{ type: "effort" as const, values: ["low", "medium", "high"] }]
      : [{ type: "toggle" as const }]
    : undefined
  const vision = metadata.vision === true
  const agentContext = metadata.agentContext
  const price = prices[id] ? perMtok(prices[id]!) : undefined
  return {
    id,
    name: EZK.autoModels[id] ?? prettyName(id),
    release_date: "",
    attachment: vision,
    // The gateway does not publish capabilities. Keep requests plain: no reasoning_effort variants unless the
    // user opts in through provider.ezkielyna.models in the config.
    reasoning,
    ...(reasoningOptions?.length ? { reasoning_options: reasoningOptions } : {}),
    temperature: true,
    tool_call: true,
    // DeepSeek thinking models need reasoning_content echoed back between tool calls.
    interleaved: deepseek ? ({ field: "reasoning_content" } as const) : undefined,
    // input 100k - 20k compaction buffer = auto-compaction around 80k tokens: long contexts make every turn slower.
    limit: {
      context: agentContext ?? 128_000,
      input: agentContext ?? 100_000,
      output: metadata.maxOutput ?? 16_384,
    },
    modalities: { input: vision ? (["text", "image", "pdf"] as const) : (["text"] as const), output: ["text"] as const },
    cost: price ? { input: price.input, output: price.output, cache_read: price.cachedInput } : { input: 0, output: 0 },
    ...(metadata.groups ? { groups: metadata.groups } : {}),
    ...(metadata.groupRatio ? { groupRatio: metadata.groupRatio } : {}),
  }
}

/** models.dev-shaped provider entry for Ezkielyna. */
export function catalogProvider(
  ids: string[] = [...EZK.fallbackModels],
  metadata: Record<string, ModelMetadata> = {},
  prices: Record<string, Price> = STATIC_PRICES,
) {
  return {
    id: EZK.providerID,
    name: EZK.providerName,
    env: [EZK.envKey],
    npm: "@ai-sdk/openai-compatible",
    api: EZK.baseURL,
    models: Object.fromEntries(ids.map((id) => [id, modelEntry(id, metadata[id], prices)])),
  }
}

/** Remove upstream-hosted providers (Ezkielyna Agent Zen / Go) so nothing ever talks to opencode.ai. */
const UPSTREAM_PROVIDERS = new Set(["opencode", "opencode-go"])

export function withEzkielyna<T extends Record<string, unknown>>(catalog: T): T {
  const next: Record<string, unknown> = {}
  for (const [id, provider] of Object.entries(catalog)) if (!UPSTREAM_PROVIDERS.has(id)) next[id] = provider
  next[EZK.providerID] = catalogProvider()
  return next as T
}

// --- dynamic model list -----------------------------------------------------------------------------------------

type Cached = { at: number; ids: string[] }
export type ModelListResult = {
  ids: string[]
  source: "remote" | "cache" | "fallback"
  reachable: boolean
  status?: number
  ms: number
  error?: string
}

const modelListTtl = 30_000
const modelListPending = new Map<string, Promise<ModelListResult>>()
const modelListRecent = new Map<string, { at: number; result: ModelListResult }>()

function cacheFile(cacheDir: string, key: string) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16)
  return path.join(cacheDir, `ezkielyna-models-${digest}.json`)
}

function readCache(cacheDir: string, key: string): Cached | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(cacheDir, key), "utf8")) as Cached
    if (Array.isArray(parsed.ids) && parsed.ids.length) return parsed
  } catch {}
}

function writeCache(cacheDir: string, key: string, ids: string[]) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(cacheFile(cacheDir, key), JSON.stringify({ at: Date.now(), ids } satisfies Cached), { mode: 0o600 })
  } catch {}
}

/**
 * The chat models this key may use, from GET {baseURL}/models.
 * Falls back to the last good answer for the same key (cached by key hash, key itself is never stored), and
 * finally to EZK.fallbackModels. Never throws.
 */
export async function listModels(input: {
  key?: string
  baseURL?: string
  cacheDir: string
  timeoutMs?: number
  fetch?: typeof fetch
  share?: boolean
}): Promise<ModelListResult> {
  const key = input.key
  if (!key) return { ids: [...EZK.fallbackModels], source: "fallback", reachable: false, ms: 0 }
  const base = (input.baseURL || EZK.baseURL).replace(/\/+$/, "")
  if (!input.share) return loadModelList(input, base, key)
  const requestKey = createHash("sha256").update(`${base}\0${key}`).digest("hex")
  const recent = modelListRecent.get(requestKey)
  if (recent && Date.now() - recent.at < modelListTtl) return recent.result
  const pending = modelListPending.get(requestKey)
  if (pending) return pending

  const request = loadModelList(input, base, key)
  modelListPending.set(requestKey, request)
  try {
    const result = await request
    if (modelListRecent.size >= 32) modelListRecent.delete(modelListRecent.keys().next().value!)
    modelListRecent.set(requestKey, { at: Date.now(), result })
    return result
  } finally {
    if (modelListPending.get(requestKey) === request) modelListPending.delete(requestKey)
  }
}

async function loadModelList(input: { key?: string; baseURL?: string; cacheDir: string; timeoutMs?: number; fetch?: typeof fetch }, base: string, key: string): Promise<ModelListResult> {
  const started = Date.now()
  let status: number | undefined
  let error: string | undefined
  try {
    const res = await (input.fetch ?? fetch)(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": `ezkielyna-agent` },
      signal: AbortSignal.timeout(input.timeoutMs ?? 5000),
    })
    status = res.status
    if (res.ok) {
      const body = (await res.json()) as { data?: { id?: unknown }[] }
      const ids = (body.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string" && isChatModel(id))
      if (ids.length) {
        writeCache(input.cacheDir, key, ids)
        return { ids, source: "remote", reachable: true, status, ms: Date.now() - started }
      }
      return { ids: [], source: "fallback", reachable: true, status, ms: Date.now() - started }
    }
    error = `HTTP ${res.status}`
  } catch (cause) {
    error = (cause as Error).name === "TimeoutError" ? "timeout" : (cause as Error).message
  }
  const cached = readCache(input.cacheDir, key)
  const ms = Date.now() - started
  if (cached) return { ids: cached.ids, source: "cache", reachable: false, status, ms, error }
  return { ids: [...EZK.fallbackModels], source: "fallback", reachable: false, status, ms, error }
}

/** Replace the Ezkielyna provider's models with the key's real list. */
export function applyModelList<T extends { models: Record<string, unknown> }>(
  provider: T,
  ids: string[],
  metadata: Record<string, ModelMetadata> = {},
  prices: Record<string, Price> = STATIC_PRICES,
): T {
  return { ...provider, models: catalogProvider(ids, metadata, prices).models }
}

/**
 * Shell commands allowed without asking: exact strings only. A wildcard would also match a trailing redirect
 * (`ls * ` matches `ls > file`, because the matcher sees the whole redirected statement), so no `*` here.
 */
export const SAFE_BASH_PLAIN = ["ls", "ls -l", "ls -la", "ls -a", "pwd"]
/**
 * git read commands run without asking only in TRUSTED projects: in a folder someone else wrote, a planted `.git/config` can set
 * `core.fsmonitor`, `diff.external` or `core.pager` and make even `git status` run a program.
 */
export const SAFE_BASH_GIT = ["git status", "git status -s", "git diff", "git diff --stat", "git log", "git log --oneline"]
export const SAFE_BASH = [...SAFE_BASH_PLAIN, ...SAFE_BASH_GIT]

/**
 * "Ask before acting" is the default: upstream Ezkielyna Agent allows edits and shell commands without asking. Read-only search
 * tools stay allowed; file changes, shell commands (except a short read-only list) and web fetches ask first.
 * This is the lowest permission layer of every agent (agent/agent.ts `defaults`), so the plan and explore agents'
 * own denials still win over it, and anything the user writes in their config wins over both.
 */
export function askFirstPermission(trusted: boolean) {
  return {
    edit: "ask",
    webfetch: "ask",
    bash: {
      "*": "ask",
      ...Object.fromEntries((trusted ? SAFE_BASH : SAFE_BASH_PLAIN).map((cmd) => [cmd, "allow"])),
    } as Record<string, "allow" | "ask">,
  } as const
}
/** The trusted-project default (kept for tests and docs). */
export const ASK_FIRST_PERMISSION = askFirstPermission(true)

/** Config merged underneath every user/project config: privacy-first defaults. */
export function configDefaults() {
  return {
    share: "disabled" as const,
    autoupdate: "notify" as const,
    disabled_providers: [...UPSTREAM_PROVIDERS],
    // Lean tool catalog = shorter prompt = faster first token. Re-enable with {"tools": {"task": true}} in ezkielyna.json.
    tools: { skill: false, task: false },
    compaction: { auto: true, prune: true },
  }
}
