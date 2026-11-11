// Ezkielyna Agent v1.1: incremental session signals for the router (files touched, failing shell loops, tool errors).
// Updated from plugin hooks as events happen, so a routing decision never has to re-read the transcript (<= 5 ms).
import type { TurnSignals } from "./classify"

const FILE_TOOLS = new Set(["read", "edit", "write", "patch", "apply_patch"])
const SHELL_TOOLS = new Set(["bash", "shell"])
const ERROR_WINDOW = 5

interface State {
  files: Set<string>
  failingLoop: number
  recentErrors: boolean[]
}

export class SessionSignals {
  private sessions = new Map<string, State>()

  private state(id: string): State {
    let s = this.sessions.get(id)
    if (!s) {
      s = { files: new Set(), failingLoop: 0, recentErrors: [] }
      this.sessions.set(id, s)
    }
    return s
  }

  /** A tool finished (hook tool.execute.after). */
  toolDone(sessionID: string, tool: string, args: any, metadata: any) {
    const s = this.state(sessionID)
    if (FILE_TOOLS.has(tool)) {
      const f = args?.filePath ?? args?.path
      if (typeof f === "string" && f) s.files.add(f)
    }
    if (SHELL_TOOLS.has(tool)) {
      const exit = metadata?.exit
      if (typeof exit === "number" && exit !== 0) s.failingLoop += 1
      else if (exit === 0) s.failingLoop = 0
    }
    s.recentErrors.push(false)
    if (s.recentErrors.length > ERROR_WINDOW) s.recentErrors.shift()
  }

  /** A tool part ended in the error state (event message.part.updated). */
  toolError(sessionID: string) {
    const s = this.state(sessionID)
    s.recentErrors.push(true)
    if (s.recentErrors.length > ERROR_WINDOW) s.recentErrors.shift()
  }

  snapshot(sessionID: string): Pick<TurnSignals, "filesTouched" | "failingLoop" | "toolErrors"> {
    const s = this.state(sessionID)
    return {
      filesTouched: s.files.size,
      failingLoop: s.failingLoop,
      toolErrors: s.recentErrors.filter(Boolean).length,
    }
  }

  forget(sessionID: string) {
    this.sessions.delete(sessionID)
  }
}
