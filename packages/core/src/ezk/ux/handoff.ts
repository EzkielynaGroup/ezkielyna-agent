// Ezkielyna Agent v3 C4: /handoff <goal>. Pure logic: the bounded digest a cheap model reads, the files worth
// carrying over (from the transcript, not guessed by the model) and the prefilled prompt of the new session.
import type { UxMessage } from "./types"

const MAX_FILES = 15
const FILE_TOOLS = new Set(["read", "edit", "write", "apply_patch", "multiedit"])

/** Files this session touched, most recent first: changed files, then files the agent read. Relative to `root`. */
export function handoffFiles(messages: UxMessage[], root: string, max = MAX_FILES): string[] {
  const seen: string[] = []
  const add = (file: unknown) => {
    if (typeof file !== "string" || !file) return
    const rel = relative(file, root)
    if (rel && !seen.includes(rel)) seen.push(rel)
  }
  const recent = messages.toReversed()
  for (const msg of recent) for (const p of msg.parts.toReversed()) if (p.type === "patch") for (const f of p.files as string[]) add(f)
  for (const msg of recent)
    for (const p of msg.parts.toReversed())
      if (p.type === "tool" && FILE_TOOLS.has(p.tool)) add(p.state?.input?.filePath ?? p.state?.input?.path)
  return seen.slice(0, max)
}

function relative(file: string, root: string) {
  const f = file.replaceAll("\\", "/")
  const r = root.replaceAll("\\", "/").replace(/\/+$/, "")
  if (r && f.startsWith(r + "/")) return f.slice(r.length + 1)
  if (f.startsWith("/") || /^[a-zA-Z]:\//.test(f)) return undefined // outside the project: not carried over
  return f.replace(/^\.\//, "")
}

/** What the cheap model reads: the user's requests, the assistant's conclusions and the tool trail, bounded. */
export function handoffDigest(messages: UxMessage[], maxChars = 20_000): string {
  const lines = messages.flatMap((msg) =>
    msg.parts.flatMap((p) => {
      if (p.type === "text" && !p.synthetic && p.text) return [`${msg.info.role === "user" ? "User" : "Assistant"}: ${String(p.text).slice(0, 1_500)}`]
      if (p.type === "tool" && p.state?.status === "error") return [`Tool ${p.tool} failed: ${String(p.state.error ?? "").slice(0, 200)}`]
      return []
    }),
  )
  const text = lines.join("\n")
  return text.length > maxChars ? `[earlier part cut]\n${text.slice(-maxChars)}` : text
}

export const HANDOFF_SYSTEM = [
  "You write the first message of a NEW coding session that continues work from an old one.",
  "The new session will not see the old conversation, only your message, so include every fact it needs:",
  "the goal, what is already done, decisions and constraints, what failed, and the next concrete steps.",
  "Write it as the user speaking to the agent, in the user's language. Be concise (at most 300 words). No preamble, no sign-off.",
].join(" ")

export function handoffRequest(goal: string, digest: string, files: string[]) {
  return [
    `Goal of the new session: ${goal.trim()}`,
    files.length ? `Relevant files: ${files.join(", ")}` : "",
    "",
    "Old session (oldest first):",
    digest,
  ]
    .filter((line, i) => line || i > 1)
    .join("\n")
}

/** The prefilled text of the new session: the written prompt, then the file list as @mentions the user can edit. */
export function handoffPrompt(written: string, goal: string, files: string[]) {
  const body = written.trim() || `Goal: ${goal.trim()}`
  return files.length ? `${body}\n\nRelevant files: ${files.map((f) => `@${f}`).join(" ")}` : body
}
