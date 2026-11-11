// JSON shapes of the /ezk/exec routes, shared by the server, the TUI `/tasks` dialog and the desktop tasks panel.
import type { ExecInfo } from "./manager"
import type { ContextBreakdown } from "../diag/context"
import type { UsageReport } from "../diag/usage"

export type ExecTaskView = ExecInfo & {
  /** last lines of output, ANSI-stripped, for list rows */
  preview: string
}

export type ExecTasksResponse = { enabled: boolean; tasks: ExecTaskView[] }

export type ExecOutputResponse = { id: string; output: string }

export function lastLines(text: string, count = 3) {
  return text.trimEnd().split("\n").slice(-count).join("\n")
}

export type ContextResponse = { enabled: false } | { enabled: true; breakdown: ContextBreakdown | null }

export type UsageResponse =
  | { enabled: false; statusline: false }
  | { enabled: true; statusline: boolean; report: UsageReport; contextPct?: number }
