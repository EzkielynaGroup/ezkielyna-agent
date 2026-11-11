// Ezkielyna Agent v3 "ux" lane: client for /ezk/ux/* (rewind, plan approval, handoff). The server owns the logic.
import type { Checkpoint, RewindMode } from "@opencode-ai/core/ezk/ux/checkpoints"
import type { ApprovalMode } from "@opencode-ai/core/ezk/ux/plan"
import type { EzkTransport } from "../api"

export interface UxStatus {
  rewind: boolean
  rewindMax: number
  planApproval: boolean
  subagents: boolean
  handoff: boolean
}

export interface RewindResult {
  mode: RewindMode
  restored: string[]
  skipped: string[]
  undo?: string
  summaryMessageID?: string
  warning?: "no-snapshot"
}

export interface HandoffResult {
  sessionID: string
  prompt: string
  files: string[]
  agent?: string
}

async function call<T>(t: EzkTransport, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers = new Headers(t.headers)
  if (body !== undefined) headers.set("content-type", "application/json")
  const res = await t.fetch(`${t.url.replace(/\/+$/, "")}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`)
  return json
}

const q = encodeURIComponent

export const ux = (t: EzkTransport) => ({
  status: () => call<UxStatus>(t, "GET", "/ezk/ux/status"),
  checkpoints: (sessionID: string) =>
    call<{ checkpoints: Checkpoint[]; diskBytes: number; diskText: string }>(t, "GET", `/ezk/ux/checkpoints?sessionID=${q(sessionID)}`),
  rewind: (b: { sessionID: string; messageID: string; mode: RewindMode; lang?: string }) => call<RewindResult>(t, "POST", "/ezk/ux/rewind", b),
  undo: (sessionID: string, snapshot: string) => call<{ ok: boolean }>(t, "POST", "/ezk/ux/rewind/undo", { sessionID, snapshot }),
  approve: (b: { sessionID: string; mode: ApprovalMode; text?: string; lang?: string }) =>
    call<{ mode: ApprovalMode; todos: number; forced: boolean; planPath: string }>(t, "POST", "/ezk/ux/plan/approve", b),
  handoff: (sessionID: string, goal: string) => call<HandoffResult>(t, "POST", "/ezk/ux/handoff", { sessionID, goal }),
})

let cached: Promise<UxStatus> | undefined
/** Feature flags of the server, fetched once per TUI process (flags are read at server start). */
export function uxStatus(t: EzkTransport) {
  cached ??= ux(t)
    .status()
    .catch(() => ({ rewind: false, rewindMax: 0, planApproval: false, subagents: false, handoff: false }))
  return cached
}
