// Ezkielyna Agent Wave B C5: threshold-gated deferred MCP tools with a BM25 `tool_search`.
// Builds on the v0.9 `mcp-defer` meta tools (mcp_call). Differences:
//   - nothing is deferred until the MCP schemas exceed `threshold` (default 10%) of the real context window;
//   - servers marked alwaysLoad keep their full schemas;
//   - `tool_search({query | names, limit})` ranks tools with BM25 over names + descriptions and returns full schemas;
//   - the index (name + one line) sits in the description of `mcp_call`, so the bytes stay identical turn to turn
//     while the connected servers do not change (prompt caching stays valid).
import { bm25, type Doc } from "./bm25"
import type { DeferrableTool, MetaToolSpec } from "../speed/mcp-defer"

export interface SearchableTool extends DeferrableTool {
  /** MCP server this tool belongs to (for alwaysLoad). */
  server?: string
}

const INDEX_DESC_MAX = 80
const INDEX_FULL_MAX = 150
const INDEX_LIST_MAX = 400

export const estimateTokens = (s: string) => Math.ceil(s.length / 4)

function schemaOf(t: DeferrableTool): unknown {
  const s: any = t.inputSchema
  if (s && typeof s === "object" && "jsonSchema" in s) return s.jsonSchema
  return s ?? { type: "object", properties: {} }
}

/** Tokens that one tool costs in every request: name + description + JSON schema (chars/4 estimate). */
export function toolTokens(name: string, t: DeferrableTool): number {
  return estimateTokens(name + (t.description ?? "") + JSON.stringify(schemaOf(t)) ) + 12
}

export function totalTokens(tools: Record<string, DeferrableTool>): number {
  let n = 0
  for (const [k, t] of Object.entries(tools)) n += toolTokens(k, t)
  return n
}

const oneLine = (s: string | undefined, max: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim()
  return t.length <= max ? t : t.slice(0, max - 1) + "…"
}

export function buildCompactIndex(tools: Record<string, DeferrableTool>): string {
  const keys = Object.keys(tools).sort()
  const shown = keys.slice(0, INDEX_LIST_MAX)
  const withDesc = keys.length <= INDEX_FULL_MAX
  const lines = shown.map((k) => (withDesc ? `- ${k}: ${oneLine(tools[k]!.description, INDEX_DESC_MAX)}` : `- ${k}`))
  if (keys.length > shown.length) lines.push(`- ... and ${keys.length - shown.length} more: use tool_search to find them`)
  return lines.join("\n")
}

export interface DeferralPlan {
  /** Tools that stay as normal tools (alwaysLoad servers). */
  loaded: Record<string, SearchableTool>
  /** Tools replaced by the index + tool_search + mcp_call. */
  deferred: Record<string, SearchableTool>
  tokens: { total: number; threshold: number; contextTokens: number }
}

/**
 * Decide what to defer. Returns undefined when everything should be sent in full (below threshold, or no real
 * context size known, or nothing left to defer).
 */
export function planDeferral(
  tools: Record<string, SearchableTool>,
  opts: { contextTokens: number; threshold?: number; alwaysLoad?: (server: string | undefined, key: string) => boolean },
): DeferralPlan | undefined {
  if (!(opts.contextTokens > 0)) return undefined
  const threshold = Math.floor(opts.contextTokens * (opts.threshold ?? 0.1))
  const total = totalTokens(tools)
  if (total <= threshold) return undefined
  const loaded: Record<string, SearchableTool> = {}
  const deferred: Record<string, SearchableTool> = {}
  for (const [k, t] of Object.entries(tools)) (opts.alwaysLoad?.(t.server, k) ? loaded : deferred)[k] = t
  if (Object.keys(deferred).length === 0) return undefined
  return { loaded, deferred, tokens: { total, threshold, contextTokens: opts.contextTokens } }
}

export function buildSearchTools(deferred: Record<string, SearchableTool>): MetaToolSpec[] {
  const names = Object.keys(deferred).sort()
  const docs: Doc[] = names.map((id) => ({ id, name: id, description: [deferred[id]!.server, deferred[id]!.description].filter(Boolean).join(" ") }))
  const index = buildCompactIndex(deferred)

  const show = (id: string) => {
    const t = deferred[id]!
    return `${id}: ${t.description ?? ""}\nschema: ${JSON.stringify(schemaOf(t))}`
  }

  const search: MetaToolSpec = {
    name: "tool_search",
    description:
      "Find MCP tools and load their full argument schemas. Pass `query` (keywords, ranked by relevance) or `names` (exact tool names from the mcp_call index). Then run the tool with mcp_call.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords describing what you need, e.g. 'create github issue'" },
        names: { type: "array", items: { type: "string" }, description: "Exact MCP tool names to load" },
        limit: { type: "integer", description: "Max results for query (default 5, max 10)" },
      },
    },
    run: async (args) => {
      const out: string[] = []
      const asked: string[] = Array.isArray(args?.names) ? args.names.map(String) : typeof args?.names === "string" ? [args.names] : []
      for (const n of asked.slice(0, 10)) out.push(deferred[n] ? show(n) : `${n}: unknown tool. Try tool_search with a query.`)
      const query = typeof args?.query === "string" ? args.query.trim() : ""
      if (query) {
        const limit = Math.min(10, Math.max(1, Math.floor(Number(args?.limit)) || 5))
        const hits = bm25(docs, query, limit)
        if (hits.length === 0) out.push(`No MCP tool matches "${query}". Index:\n${index}`)
        for (const h of hits) if (!asked.includes(h.id)) out.push(show(h.id))
      }
      if (out.length === 0) return "Pass query or names. Index of MCP tools:\n" + index
      return out.join("\n\n")
    },
  }

  const call: MetaToolSpec = {
    name: "mcp_call",
    description:
      "Call an MCP tool by name. If you do not know its arguments, call tool_search first.\nAvailable MCP tools:\n" + index,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "MCP tool name from the index" },
        arguments: { type: "object", description: "Arguments for that tool" },
      },
      required: ["name"],
    },
    run: async (args, opts) => {
      const name = typeof args?.name === "string" ? args.name : ""
      const t = deferred[name]
      if (!t || !t.execute) return `Unknown MCP tool "${name}". Use tool_search to find the right name.`
      const a = args?.arguments
      let parsed: unknown = a
      if (typeof a === "string") {
        try {
          parsed = JSON.parse(a)
        } catch {
          parsed = undefined
        }
      }
      return t.execute(parsed && typeof parsed === "object" ? parsed : {}, opts)
    },
  }
  return [search, call]
}

/** Bytes the model sees for a set of tool definitions (name + description + schema), for measurements. */
export function metaTokens(metas: MetaToolSpec[]): number {
  return metas.reduce((n, m) => n + estimateTokens(m.name + m.description + JSON.stringify(m.parameters)) + 12, 0)
}
