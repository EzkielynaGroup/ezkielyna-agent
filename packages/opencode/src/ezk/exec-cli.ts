// X1 `ezkielyna exec`: one task, no interactive UI, for scripts and CI. `--json` prints Codex-compatible JSONL events
// (core/src/ezk/exec/codex-events.ts); without it, progress goes to stderr and the final message to stdout.
// `run` stays as it was (raw events with --format json); `exec` is the stable automation surface.
import type { Argv } from "yargs"
import path from "path"
import { EOL } from "os"
import { stat } from "node:fs/promises"
import { Effect } from "effect"
import { effectCmd, fail } from "@/cli/effect-cmd"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import { type PermissionMode, PERMISSION_MODES, parsePermissionMode, resolveExecDirectory } from "@opencode-ai/core/ezk/exec/headless"

export const ExecCommand = effectCmd({
  command: "exec [prompt..]",
  describe: "run one task without the interactive UI (scripts and CI; --json prints one JSON event per line)",
  directory: (args) => targetDirectory(args.cwd) ?? process.cwd(),
  builder: (yargs: Argv) =>
    yargs
      .positional("prompt", { describe: "the task; use - or pipe stdin to read it from stdin", type: "string", array: true, default: [] })
      .option("json", { type: "boolean", default: false, describe: "print JSONL events (thread.*, turn.*, item.*, error) to stdout" })
      .option("output-schema", { type: "string", describe: "JSON Schema file the final message must match (one retry if it does not)" })
      .option("output-last-message", { alias: ["o"], type: "string", describe: "write the final message to this file" })
      .option("max-turns", { type: "number", describe: "stop after this many model turns (exit code 2)" })
      .option("max-budget", { type: "number", describe: "stop when the estimated cost passes this many USD (exit code 2)" })
      .option("permission-mode", {
        type: "string",
        describe: `what to do when a tool needs approval: ${PERMISSION_MODES.join(", ")} (default ask = deny, exit code 3)`,
      })
      .option("resume", { type: "string", describe: "continue an earlier session by id" })
      .option("model", { alias: ["m"], type: "string", describe: "model as provider/model" })
      .option("agent", { type: "string", describe: "agent to use" })
      .option("variant", { type: "string", describe: "model variant (reasoning effort)" })
      .option("hard", { type: "boolean", default: false, describe: "experimental best-of-three Flash attempts; requires a detected verify command" })
      .option("cwd", { alias: ["cd", "C"], type: "string", describe: "project folder to work in (default: the current directory)" }),
  handler: Effect.fn("Cli.exec")(function* (args) {
    if (!execEnabled("exec-cli")) return yield* fail("`exec` is turned off (EZK_FEATURES has -exec-cli).")
    const mode = args["permission-mode"] === undefined ? "ask" : parsePermissionMode(args["permission-mode"])
    if (!mode) return yield* fail(`Unknown --permission-mode "${args["permission-mode"]}". Use one of: ${PERMISSION_MODES.join(", ")}.`)
    for (const key of ["max-turns", "max-budget"] as const) {
      const value = args[key]
      if (value !== undefined && !(Number.isFinite(value) && value > 0)) return yield* fail(`--${key} must be a positive number.`)
    }
    const raw: string[] = args.prompt
    const words = raw.filter((w) => w !== "-")
    const piped = !process.stdin.isTTY || raw.includes("-") ? yield* Effect.promise(() => Bun.stdin.text()) : ""
    const prompt = [words.join(" "), piped].filter((s) => s.trim()).join("\n")
    if (!prompt.trim()) return yield* fail("Give a task: ezkielyna exec \"fix the failing test\" (or pipe it on stdin).")
    const directory = targetDirectory(args.cwd)
    if (!directory || !(yield* Effect.promise(() => isDirectory(directory)))) return yield* fail(`Folder not found: ${args.cwd ?? directory}`)
    process.chdir(directory)
    if (args.hard) {
      if (args["output-schema"] || args["output-last-message"] || args.resume || args.model || args.agent || args.variant) {
        return yield* fail("--hard cannot be combined with --output-schema, --output-last-message, --resume, --model, --agent, or --variant.")
      }
      const { runHardCLI } = yield* Effect.promise(() => import("./hard-mode-cli"))
      const code = yield* Effect.promise(() => runHardCLI({
        prompt,
        directory,
        json: args.json,
        maxBudgetUSD: args["max-budget"],
        write: (line) => process.stdout.write(line + EOL),
        log: (line) => process.stderr.write(line + EOL),
      }))
      process.exitCode = code
      return
    }
    const schema = args["output-schema"] ? yield* Effect.promise(() => readSchema(args["output-schema"]!)) : undefined
    if (schema instanceof Error) return yield* fail(schema.message)
    const { runExec } = yield* Effect.promise(() => import("./exec-run"))
    const code = yield* Effect.promise(() =>
      runExec({
        prompt,
        directory,
        json: args.json,
        schema,
        lastMessageFile: args["output-last-message"],
        maxTurns: args["max-turns"],
        maxBudgetUSD: args["max-budget"],
        mode: mode as PermissionMode,
        resume: args.resume,
        model: args.model,
        agent: args.agent,
        variant: args.variant,
        write: (line) => process.stdout.write(line + EOL),
        log: (line) => process.stderr.write(line + EOL),
      }),
    )
    process.exitCode = code
  }),
})

function targetDirectory(flag: string | undefined) {
  return resolveExecDirectory({ flag, cwd: () => process.cwd(), pwd: process.env.PWD, resolve: path.resolve })
}

async function isDirectory(dir: string) {
  return (await stat(dir).catch(() => undefined))?.isDirectory() ?? false
}

async function readSchema(file: string) {
  try {
    return JSON.parse(await Bun.file(path.resolve(file)).text()) as unknown
  } catch (error) {
    return new Error(`Cannot read --output-schema ${file}: ${(error as Error).message}`)
  }
}
