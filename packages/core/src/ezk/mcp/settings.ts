// Ezkielyna Agent Wave B (lane mcp-lsp): MCP settings. Read from the `ezk.mcp` key of ezkielyna.json(c), so the core
// config schema stays untouched. Pure, no dependencies besides the shared flag reader.
//
//   {
//     "ezk": { "mcp": {
//       "callTimeoutMs": 60000, "startupTimeoutMs": 15000, "maxRestarts": 2, "maxResultChars": 25000,
//       "deferThreshold": 0.10,
//       "alwaysLoad": ["docs"],                       // servers whose tools are never deferred
//       "servers": { "db": { "alwaysLoad": true, "callTimeoutMs": 120000 } }
//     } }
//   }
import { readEzkConfig } from "../flags"

export interface McpServerSettings {
  alwaysLoad?: boolean
  callTimeoutMs?: number
}

export interface McpSettings {
  callTimeoutMs: number
  startupTimeoutMs: number
  maxRestarts: number
  maxResultChars: number
  /** Fraction of the real context window above which MCP schemas are deferred (tool_search mode). */
  deferThreshold: number
  alwaysLoad: string[]
  servers: Record<string, McpServerSettings>
}

export const MCP_DEFAULTS: McpSettings = {
  callTimeoutMs: 60_000,
  startupTimeoutMs: 15_000,
  maxRestarts: 2,
  maxResultChars: 25_000,
  deferThreshold: 0.1,
  alwaysLoad: [],
  servers: {},
}

const num = (v: unknown, d: number, min = 0) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : d)
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as any) : {})

export function parseMcpSettings(raw: unknown): McpSettings {
  const r = obj(raw)
  const servers: Record<string, McpServerSettings> = {}
  for (const [name, v] of Object.entries(obj(r.servers))) {
    const s = obj(v)
    servers[name] = {
      ...(typeof s.alwaysLoad === "boolean" ? { alwaysLoad: s.alwaysLoad } : {}),
      ...(typeof s.callTimeoutMs === "number" && s.callTimeoutMs > 0 ? { callTimeoutMs: s.callTimeoutMs } : {}),
    }
  }
  return {
    callTimeoutMs: num(r.callTimeoutMs, MCP_DEFAULTS.callTimeoutMs, 1),
    startupTimeoutMs: num(r.startupTimeoutMs, MCP_DEFAULTS.startupTimeoutMs, 1),
    maxRestarts: Math.floor(num(r.maxRestarts, MCP_DEFAULTS.maxRestarts)),
    maxResultChars: Math.floor(num(r.maxResultChars, MCP_DEFAULTS.maxResultChars, 1000)),
    deferThreshold: Math.min(1, num(r.deferThreshold, MCP_DEFAULTS.deferThreshold)),
    alwaysLoad: Array.isArray(r.alwaysLoad) ? r.alwaysLoad.filter((x: unknown): x is string => typeof x === "string") : [],
    servers,
  }
}

/** @param dirs config directories, lowest priority first (same convention as loadFlags). */
export function loadMcpSettings(dirs: string[]): McpSettings {
  let merged: Record<string, any> = {}
  for (const dir of dirs) {
    const m = obj(readEzkConfig(dir).mcp)
    merged = { ...merged, ...m, servers: { ...obj(merged.servers), ...obj(m.servers) } }
  }
  return parseMcpSettings(merged)
}

export function isAlwaysLoad(settings: McpSettings, server: string): boolean {
  const per = settings.servers[server]?.alwaysLoad
  if (typeof per === "boolean") return per
  return settings.alwaysLoad.includes(server)
}

export function callTimeoutFor(settings: McpSettings, server: string, configured?: number): number {
  return settings.servers[server]?.callTimeoutMs ?? configured ?? settings.callTimeoutMs
}
