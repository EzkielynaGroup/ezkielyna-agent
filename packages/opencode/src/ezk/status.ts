// Ezkielyna desktop U5: GET /ezk/status data. Reports the real sandbox state (not the setting), web search and prices.
import { loadFlags } from "@opencode-ai/core/ezk/flags"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import type { StatusResponse } from "@opencode-ai/core/ezk/exec/status-contract"
import { perMtok } from "@opencode-ai/core/ezk/pricing"
import { permissionModeFromEnv, sandboxFor } from "@opencode-ai/core/ezk/sandbox"
import { webSearchAvailable } from "@opencode-ai/core/ezk/websearch/client"
import { readLocalKey } from "@opencode-ai/core/ezkielyna-localkey"
import { Global } from "@opencode-ai/core/global"
import { currentMode, flags as safetyFlags } from "./safety"

export async function statusFor(input: { directory: string; sessionID?: string; model?: string }): Promise<StatusResponse> {
  const mode = safetyFlags().modes.enabled
    ? currentMode(input.sessionID ?? "", input.directory).effective
    : permissionModeFromEnv()
  // Probe with a harmless command: the plan says whether a wrapper tool exists and the mode allows it.
  const plan = sandboxFor("true", mode, input.directory)
  const { ezkRuntime } = await import("@/plugin/ezk/runtime")
  const rt = ezkRuntime()
  const price = input.model ? rt.prices.get(input.model) : undefined
  return {
    sandbox: { active: plan.kind !== "none", kind: plan.kind, reason: plan.reason },
    webSearch: webSearchAvailable(loadFlags([Global.Path.config]).websearch.enabled, readLocalKey()),
    exec: execEnabled("exec"),
    price: price && input.model ? { model: input.model, groupRatio: price.groupRatio, perMtok: perMtok(price) } : undefined,
    agentContext: input.model ? rt.engine.policy.models[input.model]?.agentContext : undefined,
  }
}
