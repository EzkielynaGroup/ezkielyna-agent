// Ezkielyna Agent v3 (Wave C S6): glue between the shell tool and the OS sandbox (packages/core/src/ezk/sandbox).
// The shell tool calls four functions: parameters()/describe() when it builds its schema, plan() before running a
// command, annotate() on the result. Everything is a no-op unless the sandbox applies to the current mode
// (see sandboxWanted), so with the feature off the tool schema, prompt and behaviour are unchanged.
export * as EzkSandbox from "./sandbox"

import { Effect, Schema } from "effect"
import {
  ESCALATIONS,
  denialNote,
  detectDenial,
  escalationTitle,
  permissionModeFromEnv,
  sandboxFor,
  sandboxSwitch,
  sandboxWanted,
  unavailableTip,
  type Escalation,
  type SandboxPlan,
} from "@opencode-ai/core/ezk/sandbox"
import { escalationAlways } from "@opencode-ai/core/ezk/safety/rules"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { Global } from "@opencode-ai/core/global"
import { loadFlags } from "@opencode-ai/core/ezk/flags"
import path from "node:path"
import { BashArity } from "@/permission/arity"
import { InstanceState } from "@/effect/instance-state"
import { currentMode, flags as safetyFlags } from "@/ezk/safety"
import type * as Tool from "@/tool/tool"

/** Permission asked before an escalated run. Approvals are remembered per prefix by the permission service. */
export const ESCALATION_PERMISSION = "sandbox_escalation"

/**
 * Whether the sandbox is part of this tool's schema and text (decided once when the tool is built, so the tool list stays
 * cache-stable): not on Windows, not when the process-wide mode is Penuh or the switch is `-sandbox`, and when it is not
 * forced on with `+sandbox` only if the permission modes are enabled (new sessions then start in Edit otomatis, where the
 * sandbox applies; whether one command is really wrapped is decided per session in plan()).
 */
export function active(env: Record<string, string | undefined> = process.env, platform = process.platform) {
  if (platform === "win32") return false
  const mode = permissionModeFromEnv(env)
  if (mode === "full") return false
  const state = sandboxSwitch(env)
  if (state === "default" && loadFlags([Global.Path.config], env).modes.enabled) return sandboxWanted("acceptEdits", state)
  return sandboxWanted(mode, state)
}

/**
 * The shell tool's parameters plus the escalation fields, only when the sandbox is active. The static type stays the
 * base schema's so the tool's parameter type (used across the CLI and UIs) does not change; plan() reads the extra
 * fields itself.
 */
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

/** Stable text appended to the tool description when the sandbox is active (no paths: the prompt prefix stays cacheable). */
export function describe(description: string) {
  if (!active()) return description
  return `${description}

Sandbox:
  - Commands run in an OS sandbox: they can write only inside the project folder and the temp folder, and they have no network access. .git, .ezkielyna, .claude, .codex, .agents, .ssh and .aws are always read-only.
  - If a command fails because of the sandbox (a "Read-only file system", "Operation not permitted" or network error), call the tool again with sandbox_permissions "with_network" (network only) or "require_escalated" (outside the sandbox) and a one-line justification. Ask for this only when the task needs it.`
}

type EscalationParams = { sandbox_permissions?: Escalation; justification?: string }

let tipShown = false

/** Decides how to run one command; asks the user first when the model requested an escalation. */
export const plan = Effect.fn("EzkSandbox.plan")(function* (
  ctx: Tool.Context,
  params: { command: string } & EscalationParams,
  input: { cwd: string; root: string; shell: string; tokens?: string[] },
) {
  // The session's real permission mode (Shift+Tab, the desktop selector, --permission-mode) once the modes are on; before that
  // the EZK_PERMISSION_MODE stub, i.e. "ask" unless the process was started with a mode.
  const instance = yield* InstanceState.context
  const mode = safetyFlags().modes.enabled
    ? currentMode(ctx.sessionID, instance.directory, instance.worktree).effective
    : permissionModeFromEnv()
  const escalation = params.sandbox_permissions ?? "use_default"
  if (escalation !== "use_default" && sandboxWanted(mode, sandboxSwitch())) {
    const prefix = BashArity.prefix(input.tokens ?? params.command.split(/\s+/).filter(Boolean)).join(" ")
    const lang = detectLang()
    yield* ctx.ask({
      permission: ESCALATION_PERMISSION,
      patterns: [`${escalation}:${params.command}`],
      // "always" is only offered for prefixes that are safe to remember (never `bash *`, `python *`, `curl *`...): review M8
      always: escalationAlways(escalation, prefix),
      metadata: {
        command: params.command,
        escalation,
        justification: params.justification ?? "",
        title: escalationTitle(escalation, lang),
      },
    })
  }
  return sandboxFor(params.command, mode, input.root, {
    cwd: input.cwd,
    escalation,
    shell: input.shell,
    // Not the whole data dir: it holds the session database, snapshots and the saved key. Only the spill, log and scratch folders.
    extraWritable: ["tool-output", "log", "tmp"].map((name) => path.join(Global.Path.data, name)),
  })
})

/** Adds the plain-words sandbox note (denial) or the one-time "install bubblewrap" tip to the tool output. */
export function annotate(output: string, exitCode: number | null, sandbox: SandboxPlan) {
  const denial = detectDenial({ output, exitCode, plan: sandbox })
  if (denial) return `${output}\n\n<sandbox>\n${denialNote(denial, sandbox)}\n</sandbox>`
  if (sandbox.unavailable && !tipShown) {
    tipShown = true
    return `${output}\n\n<sandbox>\n${unavailableTip(sandbox, detectLang())}\n</sandbox>`
  }
  return output
}

/** Test hook. */
export function resetTip() {
  tipShown = false
}
