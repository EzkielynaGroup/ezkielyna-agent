// Ezkielyna Agent v0.9: deferred MCP tool disclosure (flag `mcp-defer`, OFF by default).
// Problem: every connected MCP tool sends its full JSON schema on every request (often 500+ tokens each).
// Solution: replace the MCP tools by two stable meta tools:
//   mcp_describe({names})            -> returns the full schema of the named tools (on demand)
//   mcp_call({name, arguments})      -> runs the real tool through its normal, permission-checked wrapper
// The tool index (name + short description) lives in the description of `mcp_call`, so the bytes are identical on
// every turn while the connected servers do not change, which keeps provider prompt caching valid.
// Below `minTools` nothing is deferred (a handful of schemas is cheaper than the extra round trip).

export interface DeferrableTool {
  description?: string
  inputSchema?: unknown
  execute?: (args: any, opts: any) => any
}

export interface MetaToolSpec {
  name: string
  description: string
  /** JSON schema of the arguments */
  parameters: Record<string, unknown>
  run: (args: any, opts: any) => any
}

export const MCP_DEFER_MIN_TOOLS = 4
const INDEX_DESC_MAX = 90

function toJsonSchema(t: DeferrableTool): unknown {
  const s: any = t.inputSchema
  // AI SDK jsonSchema() wrapper keeps the plain schema on .jsonSchema
  if (s && typeof s === "object" && "jsonSchema" in s) return s.jsonSchema
  return s ?? { type: "object", properties: {} }
}

function oneLine(s: string | undefined, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim()
  return t.length <= max ? t : t.slice(0, max - 1) + "…"
}

export function buildIndex(tools: Record<string, DeferrableTool>): string {
  return Object.keys(tools)
    .sort()
    .map((k) => `- ${k}: ${oneLine(tools[k]!.description, INDEX_DESC_MAX)}`)
    .join("\n")
}

/**
 * Returns the specs of the two meta tools, or undefined when deferral does not apply (too few tools).
 * The caller removes the original MCP entries from the tool record and registers the meta tools.
 */
export function deferMcpTools(
  mcp: Record<string, DeferrableTool>,
  opts: { minTools?: number } = {},
): { metaTools: MetaToolSpec[]; deferred: string[] } | undefined {
  const names = Object.keys(mcp)
  if (names.length < (opts.minTools ?? MCP_DEFER_MIN_TOOLS)) return undefined
  const index = buildIndex(mcp)
  const describe: MetaToolSpec = {
    name: "mcp_describe",
    description:
      "Return the full argument schema of one or more MCP tools listed in the mcp_call description. Call this before mcp_call when you do not know a tool's arguments.",
    parameters: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, description: "MCP tool names from the index" } },
      required: ["names"],
    },
    run: async (args) => {
      const asked: string[] = Array.isArray(args?.names) ? args.names.map(String) : typeof args?.names === "string" ? [args.names] : []
      if (asked.length === 0) return "names is required. Available MCP tools:\n" + index
      const out: string[] = []
      for (const n of asked.slice(0, 8)) {
        const t = mcp[n]
        if (!t) out.push(`${n}: unknown tool. Available: ${names.sort().join(", ")}`)
        else out.push(`${n}: ${t.description ?? ""}\nschema: ${JSON.stringify(toJsonSchema(t))}`)
      }
      return out.join("\n\n")
    },
  }
  const call: MetaToolSpec = {
    name: "mcp_call",
    description:
      "Call an MCP tool by name. Use mcp_describe first if you need its argument schema.\nAvailable MCP tools:\n" + index,
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
      const t = mcp[name]
      if (!t || !t.execute) return `Unknown MCP tool "${name}". Available: ${names.sort().join(", ")}`
      const a = args?.arguments
      const parsed = typeof a === "string" ? safeJson(a) : a
      return t.execute(parsed && typeof parsed === "object" ? parsed : {}, opts)
    },
  }
  return { metaTools: [describe, call], deferred: names }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
