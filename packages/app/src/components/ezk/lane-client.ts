// Ezkielyna Wave B "exec" lane: desktop client + strings for the background tasks panel (EN primary, ID).
import type { ExecOutputResponse, ExecTasksResponse } from "@opencode-ai/core/ezk/exec/contracts"
import { authTokenFromCredentials } from "@/utils/server"
import type { EzkConnection } from "./client"

export function laneClient(conn: EzkConnection, f: typeof fetch = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch) {
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
  return {
    tasks: (sessionID?: string) => call<ExecTasksResponse>("GET", `/ezk/exec${sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : ""}`),
    output: (id: string, sessionID: string) => call<ExecOutputResponse>("GET", `/ezk/exec/output?id=${encodeURIComponent(id)}&sessionID=${encodeURIComponent(sessionID)}`),
    stop: (id: string, sessionID: string) => call<{ ok: boolean }>("POST", "/ezk/exec/stop", { id, sessionID }),
  }
}

const en = {
  "tasks.title": "Background tasks",
  "tasks.sub": "Commands the agent left running, such as a dev server. They stop when you close the app.",
  "tasks.off": "Background tasks are off in this version.",
  "tasks.none": "Nothing is running in the background.",
  "tasks.running": "Running",
  "tasks.exited": "Finished",
  "tasks.killed": "Stopped",
  "tasks.stop": "Stop",
  "tasks.output": "Show output",
  "tasks.hide": "Hide output",
  "sidebar.tasks": "Background tasks",
} as const
export type LaneKey = keyof typeof en
const id: Record<LaneKey, string> = {
  "tasks.title": "Tugas latar belakang",
  "tasks.sub": "Perintah yang masih dijalankan asisten, misalnya server pengembangan. Semua berhenti saat aplikasi ditutup.",
  "tasks.off": "Tugas latar belakang belum aktif di versi ini.",
  "tasks.none": "Tidak ada yang berjalan di latar belakang.",
  "tasks.running": "Berjalan",
  "tasks.exited": "Selesai",
  "tasks.killed": "Dihentikan",
  "tasks.stop": "Hentikan",
  "tasks.output": "Lihat keluaran",
  "tasks.hide": "Sembunyikan keluaran",
  "sidebar.tasks": "Tugas latar",
}
export const laneT = (lang: string | undefined) => {
  const dict: Record<LaneKey, string> = lang?.toLowerCase().startsWith("id") ? id : en
  return (key: LaneKey) => dict[key] ?? en[key]
}
