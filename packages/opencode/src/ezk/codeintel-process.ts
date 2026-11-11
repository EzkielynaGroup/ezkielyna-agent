import { spawn } from "node:child_process"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { killTree } from "@opencode-ai/core/ezk/process-tree"
import type { CodeIndexWorkerInput, CodeIndexWorkerMessage } from "./codeintel-worker"

export const CODE_INDEX_WORKER_ARGUMENT = "--ezk-internal-codeindex-worker"
export const CODE_INDEX_WORKER_TIMEOUT_MS = 5 * 60_000
const MAX_STDERR = 8_192
const MAX_PROTOCOL_LINE = 64_000

declare const EZK_CODEINTEL_COMPILED: boolean

export type WorkerProgress = { ready: boolean; parsed: number; total: number }
export type WorkerCallbacks = {
  onMessage?: (message: CodeIndexWorkerMessage) => void
  onSpawn?: (pid: number | undefined) => void
}
export type WorkerCommand = { command: string; args: string[]; env?: NodeJS.ProcessEnv }
export type RunWorkerOptions = {
  workerPath?: string
  command?: WorkerCommand
  spawnChild?: typeof spawn
  timeoutMs?: number
}

export function codeIndexWorkerCommand(input: CodeIndexWorkerInput, opts: RunWorkerOptions = {}): WorkerCommand {
  if (opts.command) return opts.command
  const payload = JSON.stringify(input)
  const desktopWorker = process.env.EZK_CODEINTEL_WORKER_PATH
  if (desktopWorker) {
    return {
      command: process.execPath,
      args: [desktopWorker, payload],
      env: { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: withHeapLimit(process.env.NODE_OPTIONS) },
    }
  }

  if (typeof EZK_CODEINTEL_COMPILED !== "undefined" && EZK_CODEINTEL_COMPILED) {
    return { command: process.execPath, args: [CODE_INDEX_WORKER_ARGUMENT, payload] }
  }

  const source = opts.workerPath ?? fileURLToPath(new URL("./codeintel-worker.ts", import.meta.url))
  if (typeof (globalThis as any).Bun !== "undefined" && fs.existsSync(source)) {
    return { command: process.execPath, args: ["--smol", "run", source, payload] }
  }

  const nodeWorker = source.replace(/\.ts$/, ".js")
  if (fs.existsSync(nodeWorker)) {
    return {
      command: process.execPath,
      args: [nodeWorker, payload],
      env: { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: withHeapLimit(process.env.NODE_OPTIONS) },
    }
  }
  throw new Error("Separate code index worker is unavailable in this runtime")
}

export function runCodeIndexWorkerProcess(
  input: CodeIndexWorkerInput,
  callbacks: WorkerCallbacks = {},
  opts: RunWorkerOptions = {},
) {
  const command = codeIndexWorkerCommand(input, opts)
  const run = opts.spawnChild ?? spawn
  const child = run(command.command, command.args, {
    cwd: input.root,
    env: workerEnv(command.env),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  callbacks.onSpawn?.(child.pid)

  let stdout = ""
  let stderr = ""
  let result: Extract<CodeIndexWorkerMessage, { type: "result" }> | undefined
  let ready = false
  let settled = false
  let timedOut = false
  let cancelled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let forceKill: ReturnType<typeof setTimeout> | undefined

  const terminate = () => {
    if (child.pid) killTree(child.pid)
    else child.kill("SIGTERM")
    forceKill = setTimeout(() => child.kill("SIGKILL"), 1500)
    forceKill.unref?.()
  }

  const promise = new Promise<Extract<CodeIndexWorkerMessage, { type: "result" }>["result"]>((resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const clear = () => {
      if (timeout) clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      child.stdout?.off("data", onStdout)
      child.stderr?.off("data", onStderr)
    }
    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString()
      if (stdout.length > MAX_PROTOCOL_LINE * 2 && !stdout.includes("\n")) {
        stdout = ""
        stderr = `${stderr}\nworker protocol line exceeded ${MAX_PROTOCOL_LINE} bytes`.slice(-MAX_STDERR)
      }
      let newline = stdout.indexOf("\n")
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (line.length > MAX_PROTOCOL_LINE) {
          stderr = `${stderr}\nworker protocol line exceeded ${MAX_PROTOCOL_LINE} bytes`.slice(-MAX_STDERR)
        } else if (line) {
          try {
            const message = JSON.parse(line) as CodeIndexWorkerMessage
            if (message.type === "ready") ready = true
            if (message.type === "result") result = message
            callbacks.onMessage?.(message)
          } catch {
            stderr = `${stderr}\ninvalid worker protocol message`.slice(-MAX_STDERR)
          }
        }
        newline = stdout.indexOf("\n")
      }
    }
    const onStderr = (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_STDERR)
    }
    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", onStderr)
    child.once("error", (error) => {
      clear()
      fail(error)
    })
    child.once("close", (code, signal) => {
      clear()
      if (cancelled) return fail(Object.assign(new Error("Code index worker was cancelled"), { name: "AbortError" }))
      if (timedOut) return fail(new Error(`Code index worker timed out after ${opts.timeoutMs ?? CODE_INDEX_WORKER_TIMEOUT_MS} ms`))
      if (code === 0 && result) return (settled = true, resolve(result.result))
      const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
      fail(new Error(`Code index worker failed (${status})${stderr.trim() ? `: ${stderr.trim()}` : ready ? " after opening the index" : " before opening the index"}`))
    })
    timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, opts.timeoutMs ?? CODE_INDEX_WORKER_TIMEOUT_MS)
    timeout.unref?.()
  })

  return {
    promise,
    cancel() {
      if (settled || cancelled) return
      cancelled = true
      terminate()
    },
    get pid() {
      return child.pid
    },
  }
}

export async function runCodeIndexWorkerWithRetry(
  input: CodeIndexWorkerInput,
  callbacks: WorkerCallbacks = {},
  opts: RunWorkerOptions = {},
  onWorker?: (worker: ReturnType<typeof runCodeIndexWorkerProcess>) => void,
) {
  let firstError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const worker = runCodeIndexWorkerProcess(input, callbacks, opts)
    onWorker?.(worker)
    try {
      return await worker.promise
    } catch (error) {
      if ((error as Error).name === "AbortError" || /timed out after/.test(String((error as Error).message))) throw error
      if (attempt === 1) throw error
      firstError = error
    }
  }
  throw firstError
}

function withHeapLimit(value: string | undefined) {
  const existing = (value ?? "").split(/\s+/).filter((item) => item && !item.startsWith("--max-old-space-size="))
  return [...existing, "--max-old-space-size=384"].join(" ")
}

function workerEnv(extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return Object.assign(env, extra)
}
