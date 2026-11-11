// Unified exec (DESIGN-V3 T2): long-running commands that outlive a tool call. A command runs in a PTY (or pipes),
// the tool returns after `yield_time_ms` with a session id while it keeps running, and the model polls or writes to
// stdin later. Process-global, keyed by the owning chat session. Pure Node APIs so it also runs in the desktop's node
// server. Bounded: 1 MiB output per process, 16 live processes, idle reaper, process-tree kill on stop and exit.
import { type Spawner, type Backend, defaultSpawner } from "./backend"
import { HeadTailBuffer } from "./buffer"
import { killTree } from "./process-tree"
import type { Proc } from "../../pty/pty"
import { LIMITS } from "./limits"

export { LIMITS } from "./limits"

export type ExecStatus = "running" | "exited" | "killed"

export type ExecInfo = {
  id: string
  owner: string
  command: string
  cwd: string
  pid: number
  backend: Backend
  monitor: boolean
  status: ExecStatus
  exitCode?: number
  startedAt: number
  endedAt?: number
  lastAttendedAt: number
  /** total bytes of output produced */
  bytes: number
}

export type WaitResult = {
  id: string
  status: ExecStatus
  exitCode?: number
  /** output since the previous read by the model, ANSI-stripped, head+tail if more than the buffer */
  output: string
  omitted: number
  wallMs: number
}

export type StartInput = {
  owner: string
  command: string
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  tty?: boolean
  monitor?: boolean
}

export class ExecLimitError extends Error {
  constructor(readonly running: ExecInfo[]) {
    super(
      `Too many background processes (${running.length}/${LIMITS.maxProcesses}). Stop one with exec_stop first: ` +
        running.map((item) => `${item.id} (${item.command})`).join(", "),
    )
  }
}

export class ExecNotFoundError extends Error {
  constructor(id: string) {
    super(`No background process with session_id ${id}. Use exec_list to see the running ones.`)
  }
}

type Entry = {
  info: ExecInfo
  proc: Proc
  buffer: HeadTailBuffer
  /** read cursor of the model (absolute byte offset) */
  cursor: number
  partial: string
  stopRequested: boolean
  exited: Promise<void>
  changed: Set<() => void>
}

export type MonitorListener = (info: ExecInfo, lines: string[]) => void
export type ExitListener = (info: ExecInfo) => void

export type ManagerOptions = Partial<typeof LIMITS> & {
  spawn?: Spawner
  kill?: (pid: number, signal: NodeJS.Signals) => void
  now?: () => number
}

export class ExecManager {
  readonly limits: typeof LIMITS
  private entries = new Map<string, Entry>()
  private monitors = new Set<MonitorListener>()
  private exits = new Set<ExitListener>()
  private reaper: ReturnType<typeof setInterval> | undefined
  private counter = 0
  private readonly spawn: Spawner
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void
  private readonly now: () => number

  constructor(options: ManagerOptions = {}) {
    this.limits = { ...LIMITS, ...Object.fromEntries(Object.entries(options).filter((entry) => typeof entry[1] === "number")) }
    this.spawn = options.spawn ?? defaultSpawner
    this.kill = options.kill ?? ((pid, signal) => killTree(pid, { signal }))
    this.now = options.now ?? Date.now
  }

  async start(input: StartInput): Promise<ExecInfo> {
    const running = this.list().filter((item) => item.status === "running")
    if (running.length >= this.limits.maxProcesses) throw new ExecLimitError(running)
    const spawned = await this.spawn({ file: input.file, args: input.args, cwd: input.cwd, env: input.env, tty: input.tty ?? true })
    const now = this.now()
    const info: ExecInfo = {
      id: `bg_${++this.counter}`,
      owner: input.owner,
      command: input.command,
      cwd: input.cwd,
      pid: spawned.proc.pid,
      backend: spawned.backend,
      monitor: !!input.monitor,
      status: "running",
      startedAt: now,
      lastAttendedAt: now,
      bytes: 0,
    }
    let resolveExit!: () => void
    const entry: Entry = {
      info,
      proc: spawned.proc,
      buffer: new HeadTailBuffer(this.limits.bufferBytes),
      cursor: 0,
      partial: "",
      stopRequested: false,
      exited: new Promise<void>((resolve) => (resolveExit = resolve)),
      changed: new Set(),
    }
    this.entries.set(info.id, entry)
    spawned.proc.onData((data) => {
      entry.buffer.write(data)
      info.bytes = entry.buffer.total
      if (info.monitor) this.lines(entry, data)
      entry.changed.forEach((notify) => notify())
    })
    spawned.proc.onExit((event) => {
      if (info.monitor && entry.partial) this.emit(entry, [entry.partial])
      entry.partial = ""
      info.status = entry.stopRequested ? "killed" : "exited"
      info.exitCode = event.exitCode
      info.endedAt = this.now()
      resolveExit()
      entry.changed.forEach((notify) => notify())
      this.exits.forEach((listener) => listener({ ...info }))
      this.prune()
    })
    this.ensureReaper()
    return { ...info }
  }

  /** Wait until the process exits, `yieldMs` passes, or `signal` aborts; then return the output the model has not seen. */
  async wait(id: string, input: { yieldMs?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    const entry = this.require(id)
    const started = this.now()
    const yieldMs = clampYield(input.yieldMs ?? this.limits.defaultYieldMs, this.limits)
    entry.info.lastAttendedAt = started
    if (entry.info.status === "running") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, yieldMs)
        function done() {
          clearTimeout(timer)
          input.signal?.removeEventListener("abort", done)
          resolve()
        }
        input.signal?.addEventListener("abort", done, { once: true })
        entry.exited.then(done)
      })
    }
    return this.read(entry, started)
  }

  async write(id: string, chars: string, input: { yieldMs?: number; signal?: AbortSignal } = {}) {
    const entry = this.require(id)
    if (entry.info.status !== "running") return this.read(entry, this.now())
    entry.proc.write(chars)
    return this.wait(id, { yieldMs: input.yieldMs ?? this.limits.defaultWriteYieldMs, signal: input.signal })
  }

  /** Full stored output (head + tail) for the `/tasks` view; does not move the model's cursor. */
  output(id: string) {
    const entry = this.require(id)
    return stripAnsi(entry.buffer.slice(0).text)
  }

  get(id: string) {
    const entry = this.entries.get(id)
    return entry ? { ...entry.info } : undefined
  }

  list(owner?: string): ExecInfo[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.info })).filter((info) => !owner || info.owner === owner)
  }

  touch(id: string) {
    const entry = this.entries.get(id)
    if (entry) entry.info.lastAttendedAt = this.now()
  }

  stop(id: string) {
    const entry = this.require(id)
    if (entry.info.status !== "running") return { ...entry.info }
    entry.stopRequested = true
    this.kill(entry.info.pid, "SIGTERM")
    const timer = setTimeout(() => {
      if (entry.info.status === "running") this.kill(entry.info.pid, "SIGKILL")
    }, this.limits.killGraceMs)
    timer.unref?.()
    entry.exited.then(() => clearTimeout(timer))
    return { ...entry.info }
  }

  stopOwner(owner: string) {
    return this.list(owner)
      .filter((info) => info.status === "running")
      .map((info) => this.stop(info.id))
  }

  /** Synchronous hard stop of everything, for process exit hooks. */
  stopAll(signal: NodeJS.Signals = "SIGKILL") {
    for (const entry of this.entries.values()) {
      if (entry.info.status !== "running") continue
      entry.stopRequested = true
      this.kill(entry.info.pid, signal)
    }
  }

  /** Stop processes nobody has polled, written to or received monitor lines from for `idleMs`. */
  reap(now = this.now()) {
    return this.list()
      .filter((info) => info.status === "running" && now - info.lastAttendedAt >= this.limits.idleMs)
      .map((info) => this.stop(info.id))
  }

  onMonitor(listener: MonitorListener) {
    this.monitors.add(listener)
    return () => this.monitors.delete(listener)
  }

  onExit(listener: ExitListener) {
    this.exits.add(listener)
    return () => this.exits.delete(listener)
  }

  /** Remove finished entries; used by tests and on dispose. */
  clear() {
    this.stopAll()
    this.entries.clear()
    if (this.reaper) clearInterval(this.reaper)
    this.reaper = undefined
  }

  private read(entry: Entry, started: number): WaitResult {
    const slice = entry.buffer.slice(entry.cursor)
    entry.cursor = slice.end
    return {
      id: entry.info.id,
      status: entry.info.status,
      ...(entry.info.exitCode !== undefined ? { exitCode: entry.info.exitCode } : {}),
      output: stripAnsi(slice.text),
      omitted: slice.omitted,
      wallMs: this.now() - started,
    }
  }

  private require(id: string) {
    const entry = this.entries.get(id)
    if (!entry) throw new ExecNotFoundError(id)
    return entry
  }

  private lines(entry: Entry, data: string) {
    const text = entry.partial + stripAnsi(data)
    const parts = text.split("\n")
    const rest = parts.pop() ?? ""
    const overflow = Buffer.byteLength(rest, "utf-8") > this.limits.maxLineBytes
    entry.partial = overflow ? "" : rest
    const complete = [...parts, ...(overflow ? [rest] : [])].map((line) => line.replace(/\r$/, ""))
    if (complete.length) this.emit(entry, complete)
  }

  private emit(entry: Entry, lines: string[]) {
    this.monitors.forEach((listener) => listener({ ...entry.info }, lines))
  }

  private prune() {
    const finished = [...this.entries.values()].filter((entry) => entry.info.status !== "running")
    finished
      .toSorted((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0))
      .slice(0, Math.max(0, finished.length - this.limits.keepFinished))
      .forEach((entry) => this.entries.delete(entry.info.id))
    if (this.reaper && !this.list().some((info) => info.status === "running")) {
      clearInterval(this.reaper)
      this.reaper = undefined
    }
  }

  private ensureReaper() {
    if (this.reaper) return
    this.reaper = setInterval(() => this.reap(), this.limits.reapEveryMs)
    this.reaper.unref?.()
  }
}

export function clampYield(ms: number, limits: Pick<typeof LIMITS, "minYieldMs" | "maxYieldMs"> = LIMITS) {
  if (!Number.isFinite(ms)) return limits.minYieldMs
  return Math.min(limits.maxYieldMs, Math.max(limits.minYieldMs, Math.floor(ms)))
}

// CSI / OSC / single-char escapes, then bare carriage returns (progress bars) and CRLF.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
export function stripAnsi(text: string) {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line))
    .join("\n")
}

let shared: ExecManager | undefined
let hooked = false

/** The process-wide manager. Installs exit hooks once so no child outlives the app. */
export function execManager() {
  if (shared) return shared
  shared = new ExecManager()
  installExitHooks(shared)
  return shared
}

export function installExitHooks(manager: ExecManager) {
  if (hooked) return
  hooked = true
  process.once("exit", () => manager.stopAll("SIGKILL"))
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      manager.stopAll("SIGKILL")
      // Only re-raise when nobody else handles the signal; otherwise the app's own handler decides when to exit.
      if (process.listenerCount(signal) > 1) return
      process.removeListener(signal, handler)
      process.kill(process.pid, signal)
    }
    process.on(signal, handler)
  }
}
