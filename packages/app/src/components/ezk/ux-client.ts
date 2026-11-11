// Ezkielyna Agent v3 "ux" lane: Desktop client for /ezk/ux/* (rewind, plan approval, handoff). Server owns the logic.
import type { Checkpoint, RewindMode } from "@opencode-ai/core/ezk/ux/checkpoints"
import type { ApprovalMode } from "@opencode-ai/core/ezk/ux/plan"
import { authTokenFromCredentials } from "@/utils/server"
import type { EzkConnection } from "./client"

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

export const UX_OFF: UxStatus = { rewind: false, rewindMax: 0, planApproval: false, subagents: false, handoff: false }

export function uxClient(conn: EzkConnection, f: typeof fetch = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch) {
  const call = async <T,>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const res = await f(`${conn.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        ...(conn.password ? { Authorization: `Basic ${authTokenFromCredentials({ username: conn.username, password: conn.password })}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
    return json
  }
  const q = encodeURIComponent
  return {
    status: () => call<UxStatus>("GET", "/ezk/ux/status").catch(() => UX_OFF),
    checkpoints: (sessionID: string) =>
      call<{ checkpoints: Checkpoint[]; diskBytes: number; diskText: string }>("GET", `/ezk/ux/checkpoints?sessionID=${q(sessionID)}`),
    rewind: (b: { sessionID: string; messageID: string; mode: RewindMode; lang?: string }) => call<RewindResult>("POST", "/ezk/ux/rewind", b),
    undo: (sessionID: string, snapshot: string) => call<{ ok: boolean }>("POST", "/ezk/ux/rewind/undo", { sessionID, snapshot }),
    approve: (b: { sessionID: string; mode: ApprovalMode; text?: string; lang?: string }) =>
      call<{ mode: ApprovalMode; todos: number; forced: boolean; planPath: string }>("POST", "/ezk/ux/plan/approve", b),
    handoff: (sessionID: string, goal: string) =>
      call<{ sessionID: string; prompt: string; files: string[] }>("POST", "/ezk/ux/handoff", { sessionID, goal }),
  }
}
