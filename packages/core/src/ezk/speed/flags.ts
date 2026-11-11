// Ezkielyna Agent v0.9 speed flags. Pure, no dependencies.
// Kill switch / opt-in list, same style as the rest of the agent: EZK_FEATURES="-tolerant-edit,-watchdog,+mcp-defer".
//   tolerant-edit  default ON   (never changes prompt bytes: only repairs tool arguments at execution time)
//   watchdog       default ON   (no-op when the router already guards the request)
//   mcp-defer      default OFF  (changes the tool list sent to the model, so it is opt-in)
//   fingerprint-log default OFF (dev diagnostics only)
// Wave B (lane mcp-lsp):
//   mcp-robust     default ON   (timeouts, crash-restart cap, tree-kill, result cap: no prompt-byte change)
//   mcp-async      default OFF  (connect MCP servers in the background: tools appear a few seconds later)
//   mcp-search     default OFF  (threshold-gated deferral + BM25 tool_search; changes the tool list)
//   code-intel     default OFF  (LSP tool only when a server is attached, tree-sitter syntax check, no auto-install)
export type SpeedFeature =
  | "tolerant-edit"
  | "watchdog"
  | "mcp-defer"
  | "fingerprint-log"
  | "mcp-robust"
  | "mcp-async"
  | "mcp-search"
  | "code-intel"

const DEFAULTS: Record<SpeedFeature, boolean> = {
  "tolerant-edit": true,
  watchdog: true,
  "mcp-defer": false,
  "fingerprint-log": false,
  "mcp-robust": true,
  "mcp-async": false,
  "mcp-search": false,
  "code-intel": false,
}

export function speedEnabled(feature: SpeedFeature, env: Record<string, string | undefined> = process.env): boolean {
  let on = DEFAULTS[feature]
  for (const raw of (env.EZK_FEATURES ?? "").split(",")) {
    const item = raw.trim().toLowerCase()
    if (!item) continue
    if (item === `-${feature}`) on = false
    else if (item === `+${feature}` || item === feature) on = true
  }
  return on
}
