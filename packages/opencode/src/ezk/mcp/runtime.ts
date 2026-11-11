// Ezkielyna Agent Wave B: glue between the pure MCP helpers in core and the opencode services.
import { Global } from "@opencode-ai/core/global"
import { speedEnabled } from "@opencode-ai/core/ezk/speed/flags"
import { loadMcpSettings, type McpSettings } from "@opencode-ai/core/ezk/mcp/settings"

const cache = new Map<string, McpSettings>()

/** `ezk.mcp` settings from the global config dir and the project dir (project wins). Cached per project dir. */
export function mcpSettings(projectDir: string): McpSettings {
  let s = cache.get(projectDir)
  if (!s) {
    s = loadMcpSettings([Global.Path.config, projectDir])
    cache.set(projectDir, s)
  }
  return s
}

export const mcpFlags = {
  robust: () => speedEnabled("mcp-robust"),
  async: () => speedEnabled("mcp-async"),
  search: () => speedEnabled("mcp-search"),
}
