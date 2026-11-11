// Ezkielyna Agent v3 U2: checkpoints per user turn + /rewind planning. Pure logic over the session transcript.
//
// The checkpoint marker of a user turn is the shadow-git snapshot taken right before the agent's first step for that
// turn (the `step-start` part of the first assistant reply). The processor already writes it for every step, so a
// checkpoint costs no extra write and no extra disk: it is only *selected* here. The disk is bounded by the snapshot
// store's own `git gc --prune=7.days`; the cap below bounds what /rewind offers (newest first).
import type { UxMessage } from "./types"

export interface Checkpoint {
  /** the user message the turn started with; rewinding "to" it puts the session back to just before it */
  messageID: string
  /** shadow-git tree of the project right before the agent acted on this turn; undefined when snapshots are off */
  snapshot?: string
  /** first line of the user's text, for the picker */
  preview: string
  at: number
  /** files the agent changed from this turn to the end of the session */
  files: string[]
  /** user turns from this one to the end (this one included) */
  turns: number
}

export const MAX_CHECKPOINTS = 100

const userText = (msg: UxMessage) =>
  msg.parts
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => String(p.text ?? ""))
    .join(" ")
    .trim()

/** A real turn: a user message with typed text (not a synthetic follow-up such as a background task result). */
const isTurn = (msg: UxMessage) => msg.info.role === "user" && userText(msg).length > 0

/** Checkpoints of a session, newest first, capped. */
export function listCheckpoints(messages: UxMessage[], max = MAX_CHECKPOINTS): Checkpoint[] {
  const turns = messages.flatMap((msg, index) => (isTurn(msg) ? [index] : []))
  const out = turns.map((index, n) => {
    const msg = messages[index]!
    const later = messages.slice(index)
    const files = [...new Set(later.flatMap((m) => m.parts.flatMap((p) => (p.type === "patch" ? (p.files as string[]) : []))))]
    return {
      messageID: msg.info.id,
      snapshot: firstSnapshot(messages, index),
      preview: userText(msg).split("\n")[0]!.slice(0, 120),
      at: msg.info.time.created,
      files,
      turns: turns.length - n,
    } satisfies Checkpoint
  })
  return out.reverse().slice(0, Math.max(1, max))
}

/** The step-start snapshot of the first assistant reply after messages[index] (before the next user turn). */
function firstSnapshot(messages: UxMessage[], index: number) {
  for (const msg of messages.slice(index + 1)) {
    if (isTurn(msg)) return undefined
    if (msg.info.role !== "assistant") continue
    const start = msg.parts.find((p) => p.type === "step-start" && typeof p.snapshot === "string")
    if (start) return start.snapshot as string
  }
  return undefined
}

/** The newest snapshot the agent itself left behind (its last `step-finish`). Anything different now was changed outside. */
export function lastAgentSnapshot(messages: UxMessage[]): string | undefined {
  for (const msg of messages.toReversed()) {
    if (msg.info.role !== "assistant") continue
    const finish = msg.parts.findLast((p) => p.type === "step-finish" && typeof p.snapshot === "string")
    if (finish) return finish.snapshot as string
  }
  return undefined
}

export interface FileRestorePlan {
  /** restore these to their content at the checkpoint (or delete them when they did not exist then) */
  restore: string[]
  /** changed by the agent after the checkpoint AND changed again outside the agent since: left alone, with a warning */
  skipped: string[]
}

/**
 * Which files a "restore files" rewind touches: only what the agent changed after the checkpoint, minus files someone
 * changed outside the agent since the agent's last step (detected by diffing the agent's last snapshot with now).
 */
export function planFileRestore(input: { agentFiles: string[]; changedOutside: string[] }): FileRestorePlan {
  const outside = new Set(input.changedOutside.map(normalize))
  const files = [...new Set(input.agentFiles.map(normalize))]
  return {
    restore: files.filter((f) => !outside.has(f)),
    skipped: files.filter((f) => outside.has(f)),
  }
}

const normalize = (file: string) => file.replaceAll("\\", "/")

export type RewindMode = "files" | "chat" | "both" | "summarize"
export const REWIND_MODES: RewindMode[] = ["both", "files", "chat", "summarize"]
export const isRewindMode = (v: unknown): v is RewindMode => typeof v === "string" && (REWIND_MODES as string[]).includes(v)

/** Transcript of the turns being replaced, for the summariser. Bounded: long tool outputs are cut. */
export function summaryDigest(messages: UxMessage[], fromMessageID: string, maxChars = 24_000): string {
  const start = messages.findIndex((m) => m.info.id === fromMessageID)
  if (start < 0) return ""
  const lines = messages.slice(start).flatMap((msg) =>
    msg.parts.flatMap((p) => {
      if (p.type === "text" && !p.synthetic && p.text) return [`${msg.info.role === "user" ? "User" : "Assistant"}: ${String(p.text).slice(0, 2_000)}`]
      if (p.type === "tool") return [`Tool ${p.tool}: ${JSON.stringify(p.state?.input ?? {}).slice(0, 300)}${p.state?.status === "error" ? " (failed)" : ""}`]
      if (p.type === "patch") return [`Files changed: ${(p.files as string[]).join(", ")}`]
      return []
    }),
  )
  const text = lines.join("\n")
  return text.length > maxChars ? `${text.slice(0, maxChars / 2)}\n[...]\n${text.slice(-maxChars / 2)}` : text
}

export const SUMMARY_PROMPT = [
  "You compress part of a coding conversation so it can continue without the full text.",
  "Write a short summary (at most 250 words) of the turns below: what the user asked, what was done, which files changed,",
  "what was decided and what is still open. Plain prose and short bullet points. No preamble.",
].join(" ")

/** The visible text that replaces the summarised turns. Plain words; the header tells the reader it is a summary. */
export function summaryMessage(summary: string, turns: number, lang: "en" | "id" = "en") {
  const head =
    lang === "id"
      ? `Ringkasan ${turns} giliran yang diganti lewat /rewind:`
      : `Summary of ${turns} earlier turn${turns === 1 ? "" : "s"} replaced with /rewind:`
  return `${head}\n\n${summary.trim()}`
}

/** Total size in bytes of a directory tree (the snapshot store), for the disk-usage line. Never throws. */
export async function diskUsage(dir: string): Promise<number> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const walk = async (d: string): Promise<number> => {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => [])
    const sizes = await Promise.all(
      entries.map(async (e) => {
        const p = path.join(d, e.name)
        if (e.isDirectory()) return walk(p)
        if (!e.isFile()) return 0
        return (await fs.stat(p).catch(() => undefined))?.size ?? 0
      }),
    )
    return sizes.reduce((a, b) => a + b, 0)
  }
  return walk(dir)
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
