import { spawnSync } from "node:child_process"

export type KillableProcess = { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }
export type Taskkill = (args: string[]) => { status: number | null }

/** Stop a child and its descendants on Windows; use the normal signal elsewhere. */
export function stopProcessTree(
  child: KillableProcess,
  platform: NodeJS.Platform = process.platform,
  taskkill: Taskkill = (args) => spawnSync("taskkill.exe", args, { windowsHide: true, timeout: 5000 }),
) {
  if (platform === "win32" && child.pid) {
    const result = taskkill(["/PID", String(child.pid), "/T", "/F"])
    if (result.status === 0) return
  }

  child.kill("SIGTERM")
}

// ---- pid-based helpers (unified exec, MCP servers): one copy for every lane ----

export type Runner = (file: string, args: string[]) => { status: number | null; stdout: string }

export type KillOptions = {
  signal?: NodeJS.Signals
  platform?: NodeJS.Platform
  run?: Runner
  /** process.kill, injectable for tests */
  kill?: (pid: number, signal: NodeJS.Signals | number) => void
}

const defaultRun: Runner = (file, args) => {
  const res = spawnSync(file, args, { encoding: "utf-8", timeout: 5_000, windowsHide: true })
  return { status: res.status, stdout: res.stdout ?? "" }
}

/** All descendants of `pid` (children first is not guaranteed). Uses one `ps` call on macOS/Linux. */
export function descendants(pid: number, run: Runner = defaultRun) {
  const res = run("ps", ["-A", "-o", "pid=,ppid="])
  if (res.status !== 0) return []
  const children = res.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((pair): pair is [number, number] => pair.length === 2 && pair.every(Number.isFinite))
    .reduce((map, [child, parent]) => map.set(parent, [...(map.get(parent) ?? []), child]), new Map<number, number[]>())
  const out: number[] = []
  const queue = [...(children.get(pid) ?? [])]
  while (queue.length) {
    const next = queue.shift()!
    if (out.includes(next)) continue
    out.push(next)
    queue.push(...(children.get(next) ?? []))
  }
  return out
}

/**
 * Windows: `taskkill /T /F` walks the tree itself. macOS/Linux: signal the process group (our children are started as
 * group leaders), then every descendant found by `ps`, so a grandchild that called setsid() is not left running.
 */
export function killTree(pid: number, options: KillOptions = {}) {
  const platform = options.platform ?? process.platform
  const run = options.run ?? defaultRun
  const kill = options.kill ?? ((target: number, signal: NodeJS.Signals | number) => process.kill(target, signal))
  const signal = options.signal ?? "SIGTERM"
  if (!Number.isInteger(pid) || pid <= 0) return
  if (platform === "win32") {
    // taskkill fails (access denied, already gone) without throwing; fall back to ending the one process we know.
    const res = run("taskkill.exe", ["/PID", String(pid), "/T", "/F"])
    if (res.status !== 0) {
      try {
        kill(pid, signal)
      } catch {}
    }
    return
  }
  const tree = descendants(pid, run)
  for (const target of [-pid, pid, ...tree]) {
    try {
      kill(target, signal)
    } catch {}
  }
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
