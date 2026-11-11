// Ezkielyna Wave B "exec" lane: TUI strings for /tasks, /context and /usage in plain English and Indonesian.
// Indonesian when the app's language detection says so (EZK_LANG, then the system locale); English otherwise.
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"

const en = {
  "tasks.title": "Background tasks",
  "tasks.off": "Background tasks are off. Turn them on with EZK_FEATURES=+exec.",
  "tasks.none": "No background tasks in this session.",
  "tasks.running": "running",
  "tasks.exited": "finished",
  "tasks.killed": "stopped",
  "tasks.stop": "Stop",
  "tasks.stop.ask": "Stop this task and everything it started?",
  "tasks.stopped": "Task stopped",
  "tasks.stop.failed": "Could not stop the task",
  "tasks.output": "Last output",
  "context.title": "Context window",
  "context.unknown": "Not known yet. Send a message first.",
  "usage.title": "Usage this session",
  "usage.cache": "Cache",
  "usage.none": "Nothing used yet.",
  "usage.tokens": "Tokens",
  "usage.cost": "Estimated cost",
  "usage.why": "Why the cache missed",
  "usage.steps": "Model turns",
  "usage.in": "in",
  "usage.out": "out",
  "usage.cached": "from cache",
  "usage.last": "last turn",
  "context.part.system": "System prompt",
  "context.part.tools": "Tools",
  "context.part.instructions": "Project instructions (AGENTS.md, CLAUDE.md)",
  "context.part.memory": "Memory",
  "context.part.messages": "Messages",
  "context.used": "Used",
  "context.measured": "counted by the model",
  "context.estimated": "estimated",
  "context.off": "Diagnostics are off (EZK_FEATURES has -diagnostics).",
} as const

export type LaneKey = keyof typeof en

const id: Record<LaneKey, string> = {
  "tasks.title": "Tugas latar belakang",
  "tasks.off": "Tugas latar belakang mati. Nyalakan dengan EZK_FEATURES=+exec.",
  "tasks.none": "Belum ada tugas latar belakang di sesi ini.",
  "tasks.running": "berjalan",
  "tasks.exited": "selesai",
  "tasks.killed": "dihentikan",
  "tasks.stop": "Hentikan",
  "tasks.stop.ask": "Hentikan tugas ini beserta semua yang dijalankannya?",
  "tasks.stopped": "Tugas dihentikan",
  "tasks.stop.failed": "Tugas tidak dapat dihentikan",
  "tasks.output": "Keluaran terakhir",
  "context.title": "Jendela konteks",
  "context.unknown": "Belum diketahui. Kirim pesan dulu.",
  "usage.title": "Pemakaian sesi ini",
  "usage.cache": "Cache",
  "usage.none": "Belum ada pemakaian.",
  "usage.tokens": "Token",
  "usage.cost": "Perkiraan biaya",
  "usage.why": "Kenapa cache meleset",
  "usage.steps": "Giliran model",
  "usage.in": "masuk",
  "usage.out": "keluar",
  "usage.cached": "dari cache",
  "usage.last": "giliran terakhir",
  "context.part.system": "Prompt sistem",
  "context.part.tools": "Alat",
  "context.part.instructions": "Instruksi proyek (AGENTS.md, CLAUDE.md)",
  "context.part.memory": "Memori",
  "context.part.messages": "Pesan",
  "context.used": "Terpakai",
  "context.measured": "dihitung oleh model",
  "context.estimated": "perkiraan",
  "context.off": "Diagnostik mati (EZK_FEATURES berisi -diagnostics).",
}

export function laneLang(env: Record<string, string | undefined> = process.env) {
  return detectLang(env)
}

export function laneT(lang = laneLang()) {
  const table = lang === "id" ? id : en
  return (key: LaneKey) => table[key] ?? en[key]
}
