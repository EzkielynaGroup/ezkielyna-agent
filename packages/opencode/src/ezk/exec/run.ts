// Ezkielyna exec lane (T2): what the bash tool does when unified exec is on, plus the write_stdin / exec_list /
// exec_stop tools. Permission checks stay in tool/shell.ts (unchanged); this only replaces how the approved command runs.
// Output goes back through the normal Tool wrapper, so the shared truncation API (tool/truncate.ts) cuts it.
import { Effect } from "effect"
import { HeadTailBuffer } from "@opencode-ai/core/ezk/exec/buffer"
import { shellArgv } from "@opencode-ai/core/ezk/exec/backend"
import { type ExecInfo, type WaitResult, LIMITS, clampYield, execManager } from "@opencode-ai/core/ezk/exec/manager"
import type { SandboxPlan } from "@opencode-ai/core/ezk/sandbox"
import * as Tool from "@/tool/tool"
import { EzkSandbox } from "@/ezk/sandbox"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { loadFlags } from "@opencode-ai/core/ezk/flags"
import { protectedPathMentions, protectedRoot } from "@/ezk/safety/protected-paths"
import { mentionsGitWrite } from "@/ezk/safety/git-write"
import { EXEC_LIST, EXEC_STOP, WRITE_STDIN, execListParameters, execStopParameters, writeStdinParameters } from "./schema"

const PREVIEW_CHARS = 30_000
/** a running foreground command reports progress to the UI at this interval */
const TICK_MS = 1_000

/** same shape as the legacy bash metadata (output, exit) so every renderer keeps working */
export type ShellMetadata = { output: string; exit: number | null; session_id?: string; running?: boolean; sandbox?: string; network?: boolean }

export type ShellParams = {
  command: string
  timeout?: number
  yield_time_ms?: number
  run_in_background?: boolean
  monitor?: boolean
  tty?: boolean
}

/**
 * argv for one command. When the OS sandbox applies (`sandbox.wrap` is an argv prefix such as `sandbox-exec -p <profile> --`
 * or `bwrap ... --`), the shell runs inside it, exactly like the legacy path in tool/shell.ts; otherwise the plain shell argv.
 */
export function execArgv(shell: string, command: string, sandbox?: SandboxPlan) {
  const argv = shellArgv(shell, command)
  const wrap = sandbox?.wrap
  if (!wrap?.length) return argv
  return { file: wrap[0]!, args: [...wrap.slice(1), argv.file, ...argv.args] }
}

export const runShell = Effect.fn("EzkExec.runShell")(function* (
  input: { shell: string; cwd: string; env: NodeJS.ProcessEnv; params: ShellParams; sandbox?: SandboxPlan },
  ctx: Tool.Context,
) {
  const manager = execManager()
  const params = input.params
  const started = yield* Effect.tryPromise(() =>
    manager.start({
      owner: ctx.sessionID,
      command: params.command,
      ...execArgv(input.shell, params.command, input.sandbox),
      cwd: input.cwd,
      env: Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      tty: params.tty ?? true,
      monitor: params.monitor,
    }),
  ).pipe(Effect.catch((error) => Effect.succeed(error.cause instanceof Error ? error.cause : new Error(String(error.cause)))))
  if (started instanceof Error) {
    const metadata: ShellMetadata = { output: started.message, exit: null }
    return { title: params.command, metadata, output: started.message }
  }
  if (params.timeout) {
    const timer = setTimeout(() => manager.get(started.id)?.status === "running" && manager.stop(started.id), params.timeout)
    timer.unref?.()
  }

  const yieldMs = params.run_in_background ? LIMITS.minYieldMs : clampYield(params.yield_time_ms ?? LIMITS.defaultYieldMs)
  const deadline = Date.now() + yieldMs
  const collected = new HeadTailBuffer()
  const step = (): Effect.Effect<WaitResult> =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        manager.wait(started.id, { yieldMs: Math.min(TICK_MS, Math.max(1, deadline - Date.now())), signal: ctx.abort }),
      )
      collected.write(result.output)
      yield* ctx.metadata({ metadata: { output: preview(collected.slice().text), session_id: started.id } })
      if (result.status !== "running" || Date.now() >= deadline || ctx.abort.aborted) return result
      return yield* step()
    })
  const last = yield* step()

  const aborted = ctx.abort.aborted && last.status === "running" && !params.run_in_background
  const final = aborted ? yield* stopAndDrain(started.id) : last
  if (aborted) collected.write(final.output)
  const output = collected.slice().text
  const result = format(started, final, output, { aborted, background: !!params.run_in_background })
  if (!input.sandbox) return result
  // Same sandbox notes as the legacy path: why a command was blocked (finished commands only), and what ran sandboxed.
  const finished = final.status !== "running"
  return {
    ...result,
    output: finished ? EzkSandbox.annotate(result.output, final.exitCode ?? null, input.sandbox) : result.output,
    metadata: { ...result.metadata, ...(input.sandbox.wrap ? { sandbox: input.sandbox.kind, network: input.sandbox.network } : {}) },
  }
})

const SAFETY = loadFlags([Global.Path.config])

/**
 * The permission request for typing `chars` into a running process. Same scan as the bash tool: text that mentions a protected
 * path (.git, hooks, workflows, project config ...) or runs a git write is forced to ask even if the user once allowed the
 * command. Typed input is arbitrary code in a REPL, so "always" is never offered.
 */
export function stdinAsk(info: Pick<ExecInfo, "command" | "cwd">, chars: string, root: string, protectedOn = true) {
  const protectedWrite = protectedOn && (protectedPathMentions(root, info.cwd, chars) || mentionsGitWrite(chars))
  return {
    permission: "bash",
    patterns: [info.command],
    always: [] as string[],
    metadata: { command: info.command, input: chars },
    forceAsk: protectedWrite,
  }
}

export const WriteStdinTool = Tool.define(
  "write_stdin",
  Effect.succeed({
    description: WRITE_STDIN,
    parameters: writeStdinParameters,
    execute: (params: typeof writeStdinParameters.Type, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const info = owned(params.session_id, ctx)
        const manager = execManager()
        const chars = params.chars ?? ""
        // Typing into a process can run code (a REPL, a shell prompt), so it needs the same approval as the command.
        if (chars) {
          const instance = yield* InstanceState.context
          yield* ctx.ask(stdinAsk(info, chars, protectedRoot(instance), SAFETY.safety.protectedPaths))
        }
        const result = yield* Effect.promise(() =>
          chars
            ? manager.write(info.id, chars, { yieldMs: params.yield_time_ms, signal: ctx.abort })
            : manager.wait(info.id, { yieldMs: params.yield_time_ms ?? LIMITS.defaultPollYieldMs, signal: ctx.abort }),
        )
        return format(info, result, result.output, { aborted: false, background: false })
      }),
  }),
)

export const ExecListTool = Tool.define(
  "exec_list",
  Effect.succeed({
    description: EXEC_LIST,
    parameters: execListParameters,
    execute: (_params: typeof execListParameters.Type, ctx: Tool.Context) =>
      Effect.sync(() => {
        const items = execManager().list(ctx.sessionID)
        const now = Date.now()
        const output = items.length
          ? items
              .map((item) =>
                [
                  item.id,
                  item.status === "running" ? "running" : `${item.status} (exit ${item.exitCode ?? "?"})`,
                  `${Math.round(((item.endedAt ?? now) - item.startedAt) / 1000)}s`,
                  item.monitor ? "monitor" : "",
                  item.command,
                ]
                  .filter(Boolean)
                  .join("  "),
              )
              .join("\n")
          : "No background commands in this session."
        return { title: "background commands", metadata: { count: items.length }, output }
      }),
  }),
)

export const ExecStopTool = Tool.define(
  "exec_stop",
  Effect.succeed({
    description: EXEC_STOP,
    parameters: execStopParameters,
    execute: (params: typeof execStopParameters.Type, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const info = owned(params.session_id, ctx)
        const result = yield* stopAndDrain(info.id)
        return format(info, result, result.output, { aborted: false, background: false })
      }),
  }),
)

function stopAndDrain(id: string) {
  const manager = execManager()
  manager.stop(id)
  return Effect.promise(() => manager.wait(id, { yieldMs: LIMITS.killGraceMs + 500 }))
}

function owned(id: string, ctx: Tool.Context) {
  const info = execManager().get(id)
  if (!info || info.owner !== ctx.sessionID) throw new Error(`No background command with session_id ${id} in this session. Use exec_list to see yours.`)
  return info
}

function format(info: ExecInfo, result: WaitResult, output: string, flags: { aborted: boolean; background: boolean }): Tool.ExecuteResult<ShellMetadata> {
  const seconds = (Math.max(0, (result.status === "running" ? Date.now() : (info.endedAt ?? Date.now())) - info.startedAt) / 1000).toFixed(1)
  const status =
    result.status === "running"
      ? `Still running (session_id: ${info.id}). Use write_stdin with session_id "${info.id}" to read new output or send input, exec_stop to stop it.`
      : result.status === "killed"
        ? `Stopped (session_id: ${info.id}, exit code ${result.exitCode ?? "?"}).`
        : `Process exited with code ${result.exitCode ?? "?"}.`
  const notes = [
    flags.aborted ? "User aborted the command" : "",
    flags.background && result.status === "running" ? "Started in the background." : "",
    status,
    `Wall time: ${seconds}s`,
  ].filter(Boolean)
  return {
    title: info.command,
    metadata: {
      output: preview(output || "(no output)"),
      exit: result.status === "running" ? null : (result.exitCode ?? null),
      session_id: info.id,
      running: result.status === "running",
    },
    output: `${output.trimEnd() || "(no output)"}\n\n<exec_metadata>\n${notes.join("\n")}\n</exec_metadata>`,
  }
}

function preview(text: string) {
  return text.length <= PREVIEW_CHARS ? text : "...\n\n" + text.slice(-PREVIEW_CHARS)
}
