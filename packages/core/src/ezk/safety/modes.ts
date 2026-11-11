// Ezkielyna Agent Wave B (S1): permission modes. Pure data and rules; the opencode side keeps the per-session state.
// Untrusted folders are always forced back to "ask": a mode can only relax prompts in a folder the user trusted.

export const MODES = ["ask", "acceptEdits", "plan", "safeAuto", "full"] as const
export type Mode = (typeof MODES)[number]

/** The owner default (21 Oct) for trusted folders once the modes flag is on. */
export const DEFAULT_MODE: Mode = "acceptEdits"

type Text = { en: string; id: string }

export const MODE_LABEL: Record<Mode, Text> = {
  ask: { en: "Ask first", id: "Tanya dulu" },
  acceptEdits: { en: "Auto edit", id: "Edit otomatis" },
  plan: { en: "Plan", id: "Rencana" },
  safeAuto: { en: "Safe auto", id: "Otomatis-aman" },
  full: { en: "Full", id: "Penuh" },
}

export const MODE_HINT: Record<Mode, Text> = {
  ask: {
    en: "Asks before every change, command or web access.",
    id: "Bertanya dulu sebelum mengubah file, menjalankan perintah, atau membuka web.",
  },
  acceptEdits: {
    en: "Edits files in this project by itself. Commands, web access and anything outside the project still ask.",
    id: "Mengubah file di proyek ini sendiri. Perintah, akses web, dan apa pun di luar proyek tetap bertanya.",
  },
  plan: {
    en: "Read-only: looks around and makes a plan, but changes nothing.",
    id: "Hanya membaca: melihat-lihat dan membuat rencana, tanpa mengubah apa pun.",
  },
  safeAuto: {
    en: "Like Auto edit, plus the commands you chose to always allow.",
    id: "Seperti Edit otomatis, ditambah perintah yang Anda pilih untuk selalu diizinkan.",
  },
  full: {
    en: "Does everything without asking. Only use it in a folder you fully trust.",
    id: "Melakukan semuanya tanpa bertanya. Pakai hanya di folder yang benar-benar Anda percaya.",
  },
}

export const FULL_WARNING: Text = {
  en: "Full mode: the agent runs commands and changes files without asking.",
  id: "Mode Penuh: asisten menjalankan perintah dan mengubah file tanpa bertanya.",
}

export const UNTRUSTED_NOTICE: Text = {
  en: "This folder is not trusted yet, so the agent asks first. Run `ezkielyna trust` to change modes.",
  id: "Folder ini belum dipercaya, jadi asisten bertanya dulu. Jalankan `ezkielyna trust` untuk mengganti mode.",
}

/** Accepts the canonical names plus Claude/Codex spellings, so `--permission-mode default|bypassPermissions` works too. */
export function parseMode(value: unknown): Mode | undefined {
  if (typeof value !== "string") return
  const key = value.trim().toLowerCase().replace(/[\s_-]/g, "")
  const aliases: Record<string, Mode> = {
    ask: "ask",
    default: "ask",
    manual: "ask",
    tanyadulu: "ask",
    acceptedits: "acceptEdits",
    autoedit: "acceptEdits",
    editotomatis: "acceptEdits",
    plan: "plan",
    rencana: "plan",
    readonly: "plan",
    safeauto: "safeAuto",
    auto: "safeAuto",
    otomatisaman: "safeAuto",
    full: "full",
    penuh: "full",
    bypasspermissions: "full",
    yolo: "full",
  }
  return aliases[key]
}

/** What actually applies: untrusted folders always ask, whatever was requested (plan stays: it only restricts). */
export function effectiveMode(requested: Mode, trusted: boolean): Mode {
  if (trusted || requested === "plan") return requested
  return "ask"
}

/** Shift+Tab order. Full is left out on purpose: it is chosen explicitly (CLI flag, config or the selector). */
export function nextMode(current: Mode, reverse = false): Mode {
  const order: Mode[] = ["ask", "acceptEdits", "plan", "safeAuto"]
  const index = order.indexOf(current)
  if (index === -1) return reverse ? "safeAuto" : "ask"
  return order[(index + (reverse ? order.length - 1 : 1)) % order.length]!
}

/** The appended reminder the model sees after a mode change (never part of the system prompt: cache rule). */
export function modeReminder(mode: Mode): string {
  const lines: Record<Mode, string> = {
    ask: "Permission mode is now ask-first: every edit, shell command and web fetch needs the user's approval.",
    acceptEdits:
      "Permission mode is now auto-edit: file edits inside the project are approved automatically; shell commands, web access and paths outside the project still need approval.",
    plan: "Permission mode is now plan (read-only): do not edit files or run commands that change anything. Investigate, then present a plan and wait for the user to switch modes.",
    safeAuto:
      "Permission mode is now safe-auto: edits inside the project and the user's remembered command rules run without asking; anything else needs approval.",
    full: "Permission mode is now full: actions run without approval. Stay within the user's request and avoid destructive commands.",
  }
  return `<system-reminder>\n${lines[mode]}\n</system-reminder>`
}
