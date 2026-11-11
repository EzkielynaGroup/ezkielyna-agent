// How a unified-exec process is started. Two backends with the same small surface as `src/pty/pty.ts`:
//   pty   - the existing bun-pty / node-pty dependency (`#pty`). Programs see a terminal, so prompts (`read -p`),
//           progress bars and dev servers behave as they do for the user. stdout and stderr arrive merged, with
//           terminal escapes (stripped before the model sees them).
//   pipes - node:child_process with stdin/stdout/stderr pipes. Used when tty=false, when the pty library fails to load
//           (unsupported platform, missing native module), and in the desktop's node runtime if `#pty` is unavailable.
//           Trade-off: no terminal, so some tools disable colour or buffer their output until exit.
// Both start the child as a process-group leader on macOS/Linux so the whole tree can be killed (process-tree.ts).
import { spawn as spawnChild } from "node:child_process"
import type { Proc } from "../../pty/pty"

export type Backend = "pty" | "pipes"

export type SpawnInput = {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  tty: boolean
  cols?: number
  rows?: number
}

export type Spawned = { proc: Proc; backend: Backend }

export type Spawner = (input: SpawnInput) => Promise<Spawned>

export const defaultSpawner: Spawner = async (input) => {
  // cmd.exe has its own quoting rules that a pty library's argv joining does not follow; pipes get exact control (spawnOptions).
  if (input.tty && !isCmd(input.file, process.platform)) {
    const pty = await loadPty()
    if (pty) {
      return {
        backend: "pty",
        proc: pty.spawn(input.file, input.args, {
          name: "xterm-256color",
          cols: input.cols ?? 160,
          rows: input.rows ?? 40,
          cwd: input.cwd,
          env: input.env,
        }),
      }
    }
  }
  return { backend: "pipes", proc: spawnPipes(input) }
}

let ptyModule: Promise<typeof import("#pty") | undefined> | undefined
function loadPty() {
  ptyModule ??= import("#pty").catch(() => undefined)
  return ptyModule
}

const isCmd = (file: string, platform: NodeJS.Platform) =>
  platform === "win32" && file.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "") === "cmd"

/**
 * Node quotes argv for the MS C runtime (`\"`), which cmd.exe does not understand: `cmd /d /s /c echo "a b"` would run
 * `echo \"a b\"`. For cmd we hand over the command line verbatim, wrapped in the quotes `/s` strips.
 */
export function pipeSpawnConfig(input: Pick<SpawnInput, "file" | "args">, platform: NodeJS.Platform = process.platform) {
  if (!isCmd(input.file, platform)) return { args: input.args, windowsVerbatimArguments: false }
  const at = input.args.findIndex((arg) => arg.toLowerCase() === "/c")
  if (at < 0 || at !== input.args.length - 2) return { args: input.args, windowsVerbatimArguments: false }
  return { args: [...input.args.slice(0, at + 1), `"${input.args[at + 1]}"`], windowsVerbatimArguments: true }
}

export function spawnPipes(input: SpawnInput): Proc {
  const config = pipeSpawnConfig(input)
  const child = spawnChild(input.file, config.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: config.windowsVerbatimArguments,
  })
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number; signal?: number | string }) => void>()
  // Output can arrive before the caller attaches its listener; hold it until then.
  const early: string[] = []
  const emit = (chunk: Buffer) => {
    if (!dataListeners.size) return void early.push(chunk.toString("utf-8"))
    dataListeners.forEach((listener) => listener(chunk.toString("utf-8")))
  }
  child.stdout?.on("data", emit)
  child.stderr?.on("data", emit)
  child.stdin?.on("error", () => {})
  let exited: { exitCode: number; signal?: number | string } | undefined
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return
    exited = { exitCode: code ?? (signal ? 128 + signalNumber(signal) : 1), signal: signal ?? undefined }
    exitListeners.forEach((listener) => listener(exited!))
  }
  child.on("exit", finish)
  child.on("error", (error) => {
    emit(Buffer.from(`${error.message}\n`))
    finish(127, null)
  })
  return {
    pid: child.pid ?? -1,
    onData(listener) {
      dataListeners.add(listener)
      early.splice(0).forEach((chunk) => listener(chunk))
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit(listener) {
      exitListeners.add(listener)
      if (exited) queueMicrotask(() => listener(exited!))
      return { dispose: () => exitListeners.delete(listener) }
    },
    write(data) {
      child.stdin?.write(data)
    },
    resize() {},
    kill(signal) {
      child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM")
    },
  }
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }
function signalNumber(signal: string) {
  return SIGNALS[signal] ?? 0
}

/** argv for running one command string in the user's shell. */
export function shellArgv(shell: string, command: string, platform: NodeJS.Platform = process.platform) {
  const name = shell.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "")
  if (name === "pwsh" || name === "powershell") return { file: shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }
  if (name === "cmd") return { file: shell, args: ["/d", "/s", "/c", command] }
  if (platform === "win32" && !shell) return { file: "cmd.exe", args: ["/d", "/s", "/c", command] }
  return { file: shell || "/bin/sh", args: ["-c", command] }
}
