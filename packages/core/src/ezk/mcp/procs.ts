// Process-tree cleanup for local MCP servers (stdio). Synchronous on purpose: it must work inside `process.on("exit")`.
import { descendants, stopProcessTree } from "../process-tree"

export type Pgrep = (pid: number) => number[]

/**
 * Descendants of `pid`, deepest last. Without a `pgrep` (tests inject one) this is a single `ps` snapshot from the shared
 * process-tree helper instead of one `pgrep -P` per level.
 */
export function descendantsSync(pid: number, pgrep?: Pgrep, platform = process.platform): number[] {
  if (platform === "win32") return []
  if (!pgrep) return descendants(pid).slice(0, 256)
  const out: number[] = []
  const queue = [pid]
  for (let i = 0; i < queue.length && out.length < 256; i++) {
    for (const c of pgrep(queue[i]!)) {
      if (out.includes(c)) continue
      out.push(c)
      queue.push(c)
    }
  }
  return out
}

/** Kill a process and everything below it (children first). Never throws. */
export function killTreeSync(pid: number, signal: NodeJS.Signals = "SIGKILL", pgrep?: Pgrep) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  if (process.platform === "win32") {
    stopProcessTree({ pid, kill: () => true })
    return
  }
  const all = descendantsSync(pid, pgrep).reverse()
  all.push(pid)
  for (const p of all) {
    try {
      process.kill(p, signal)
    } catch {}
  }
}

const tracked = new Set<number>()
let hooked = false

export const mcpProcs = {
  add(pid: number | null | undefined) {
    if (typeof pid === "number" && pid > 1) tracked.add(pid)
    installExitHooks()
  },
  remove(pid: number | null | undefined) {
    if (typeof pid === "number") tracked.delete(pid)
  },
  size: () => tracked.size,
  killAll(signal: NodeJS.Signals = "SIGKILL") {
    for (const pid of [...tracked]) killTreeSync(pid, signal)
    tracked.clear()
  },
}

/** Idempotent. Kills tracked servers on exit and on fatal signals (the signal is re-raised when nobody else listens). */
export function installExitHooks() {
  if (hooked) return
  hooked = true
  process.once("exit", () => mcpProcs.killAll())
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      mcpProcs.killAll()
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig)
    })
  }
}
