// X1 `ezkielyna exec`: the pure decisions of a headless run (no human to answer a permission prompt).
//   permission modes: the five modes of DESIGN-V3 S1, plus the Claude Code / Codex spellings, mapped to an answer
//   for each permission request; exit codes: 0 ok, 1 error, 2 budget or turn limit, 3 permission denied.
import { effectiveMode, parseMode, MODES, type Mode } from "../safety/modes"
import { isProtectedRelative, protectedPathMentions } from "../safety/protected-paths"

export type PermissionMode = Mode

export const PERMISSION_MODES = MODES

/**
 * The same spellings as the interactive permission modes (core/src/ezk/safety/modes.ts), so `auto` means the same thing on
 * `exec` and in the app. `dontAsk` (Claude Code's "deny what is not allowed") is the one extra alias: it is "ask" here.
 */
export function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
  if (value === undefined) return undefined
  if (value.trim().toLowerCase().replace(/[\s_-]/g, "") === "dontask") return "ask"
  return parseMode(value)
}

export type PermissionContext = {
  /** patterns of the request (file paths for `edit`, command segments for `bash`) */
  patterns?: readonly string[]
  /** is the project folder trusted (`ezkielyna trust`)? Untrusted folders never get more than "ask". Default: true. */
  trusted?: boolean
  /** project root, to resolve command mentions of protected paths */
  root?: string
}

/**
 * The reply a headless run gives to one permission request. Nobody can be asked, so "ask" means "deny" here.
 * acceptEdits (and the safeAuto placeholder, until the Wave C classifier exists) allow file edits only; edits outside
 * the project raise a separate `external_directory` request, which is denied.
 * Two rules hold in every mode, `full` included, because a human would have been asked for them too:
 *   - an untrusted folder is treated as "ask" (a mode only relaxes prompts in a folder the user trusted);
 *   - edits to protected paths (git hooks, project settings, config that defines commands, CI workflows...) and shell
 *     commands that mention them are denied; the file tools force these prompts, and here nobody can approve them.
 */
export function decidePermission(mode: PermissionMode, permission: string, context: PermissionContext = {}): "once" | "reject" {
  const effective = effectiveMode(mode, context.trusted ?? true)
  if (touchesProtected(permission, context)) return "reject"
  if (effective === "full") return "once"
  if ((effective === "acceptEdits" || effective === "safeAuto") && permission === "edit") return "once"
  return "reject"
}

function touchesProtected(permission: string, context: PermissionContext) {
  const patterns = context.patterns ?? []
  if (permission === "edit") return patterns.some((pattern) => isProtectedRelative(pattern))
  if (permission === "bash") {
    const root = context.root
    return root !== undefined && patterns.some((pattern) => protectedPathMentions(root, root, pattern))
  }
  return false
}

export type RunOutcome = {
  /** the run stopped because --max-turns or --max-budget was reached */
  limit?: "turns" | "budget"
  errors: number
  denied: number
  /** --output-schema was given and the final message still did not match after the retry */
  schemaFailed?: boolean
}

export function exitCode(outcome: RunOutcome) {
  if (outcome.limit) return 2
  if (outcome.errors > 0 || outcome.schemaFailed) return 1
  if (outcome.denied > 0) return 3
  return 0
}

export function schemaInstruction(schema: unknown) {
  return [
    "",
    "<output-format>",
    "Your final message must be only a JSON value that matches this JSON Schema. No prose, no code fence.",
    JSON.stringify(schema),
    "</output-format>",
  ].join("\n")
}

export function schemaRetryPrompt(errors: string[]) {
  return [
    "Your final message did not match the required JSON Schema:",
    ...errors.slice(0, 10).map((e) => `- ${e}`),
    "Reply again with only the corrected JSON value. No prose, no code fence.",
  ].join("\n")
}

/**
 * The project folder of a headless run: the --cwd flag (relative to the real working directory), else the real working
 * directory, and $PWD only when that cannot be read. $PWD is not trusted first: a process spawned with a `cwd` option
 * inherits its parent's PWD, which made `run` work in the caller's folder instead of the target (Bench v2 finding).
 */
export function resolveExecDirectory(input: { flag?: string; cwd: () => string; pwd?: string; resolve: (...parts: string[]) => string }) {
  const base = (() => {
    try {
      return input.cwd()
    } catch {
      return input.pwd
    }
  })()
  if (input.flag) return base ? input.resolve(base, input.flag) : input.resolve(input.flag)
  return base ? input.resolve(base) : undefined
}
