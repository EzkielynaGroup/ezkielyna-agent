// Startup-only shell-schema helpers. The OS sandbox implementation is loaded
// only when this feature can actually affect the command or its prompt.
import { Schema } from "effect"
import { permissionModeFromEnv, sandboxSwitch, sandboxWanted } from "@opencode-ai/core/ezk/sandbox/flags"
import { Global } from "@opencode-ai/core/global"
import { loadFlags } from "@opencode-ai/core/ezk/flags"

const ESCALATIONS = ["use_default", "with_network", "require_escalated"] as const

export function active(env: Record<string, string | undefined> = process.env, platform = process.platform) {
  if (platform === "win32") return false
  const mode = permissionModeFromEnv(env)
  if (mode === "full") return false
  const state = sandboxSwitch(env)
  if (state === "default" && loadFlags([Global.Path.config], env).modes.enabled) return sandboxWanted("acceptEdits", state)
  return sandboxWanted(mode, state)
}

export function parameters<S extends Schema.Struct<Schema.Struct.Fields>>(base: S): S {
  if (!active()) return base
  const extended = Schema.Struct({
    ...base.fields,
    sandbox_permissions: Schema.optional(Schema.Literals(ESCALATIONS)).annotate({
      description:
        'Leave unset. Use "with_network" to re-run a command that failed only because the sandbox blocks the network, or "require_escalated" to re-run it outside the sandbox. Both ask the user first.',
    }),
    justification: Schema.optional(Schema.String).annotate({
      description: "With sandbox_permissions: one short sentence for the user explaining why the command needs it.",
    }),
  })
  return extended as unknown as S
}

export function describe(description: string) {
  if (!active()) return description
  return `${description}

Sandbox:
  - Commands run in an OS sandbox: they can write only inside the project folder and the temp folder, and they have no network access. .git, .ezkielyna, .claude, .codex, .agents, .ssh and .aws are always read-only.
  - If a command fails because of the sandbox (a "Read-only file system", "Operation not permitted" or network error), call the tool again with sandbox_permissions "with_network" (network only) or "require_escalated" (outside the sandbox) and a one-line justification. Ask for this only when the task needs it.`
}
