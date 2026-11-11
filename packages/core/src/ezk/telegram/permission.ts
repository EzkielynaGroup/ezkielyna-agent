// Permission policy for requests coming from a Telegram-driven session: refuse anything touching files outside the chosen
// folder before a human is even asked; everything else becomes Allow/Deny buttons (default mode `ask`).
import { findEscape, isInside } from "./pathguard"

export type PermissionAsk = { id: string; sessionID: string; permission: string; patterns: string[]; metadata?: Record<string, unknown> }
export type Decision = { action: "reject"; reason: string } | { action: "ask" }

const PATH_KEYS = ["filepath", "filePath", "path", "parentDir", "directory", "workdir", "cwd"]

export function decide(root: string, ask: PermissionAsk): Decision {
  if (ask.permission === "external_directory") return { action: "reject", reason: "touches a folder outside the chosen workspace" }
  const strings: string[] = [...(ask.patterns ?? [])]
  const meta = ask.metadata ?? {}
  for (const k of PATH_KEYS) {
    const v = meta[k]
    if (typeof v === "string" && v && !isInside(root, v)) return { action: "reject", reason: `path outside the chosen workspace: ${v}` }
  }
  if (typeof meta.command === "string") strings.push(meta.command)
  for (const s of strings) {
    const escape = findEscape(root, s)
    if (escape) return { action: "reject", reason: `path outside the chosen workspace: ${escape}` }
  }
  return { action: "ask" }
}

export function describeAsk(ask: PermissionAsk): string {
  const command = typeof ask.metadata?.command === "string" ? ask.metadata.command : undefined
  const patterns = (ask.patterns ?? []).filter((value) => value !== command)
  return [
    `Permission request: ${ask.permission}`,
    ...(command ? [`Command:\n${command}`] : []),
    ...(patterns.length ? [`Details:\n${patterns.join("\n")}`] : []),
  ].join("\n")
}

/** Split permission details into Telegram-safe messages without dropping any content. */
export function splitPermissionText(text: string, maxChars = 3500): string[] {
  const max = Math.max(2, maxChars)
  if (text.length <= max) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + max, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
    chunks.push(text.slice(i, end))
    i = end
  }
  return chunks
}
