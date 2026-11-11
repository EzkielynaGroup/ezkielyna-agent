import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { isTestCommand, turnTestResult } from "./turn-summary"

export type SessionToolStep =
  | { id: string; partIDs: string[]; kind: "read"; paths: string[]; count: number }
  | { id: string; partIDs: string[]; kind: "edit" | "write"; path: string; additions?: number; deletions?: number }
  | { id: string; partIDs: string[]; kind: "test"; command: string; status: "running" | "passed" | "failed"; count?: number; durationMs?: number }
  | { id: string; partIDs: string[]; kind: "shell"; command: string }

const READ_TOOLS = new Set(["read", "grep", "glob", "list", "ls", "search", "code_search"])
const EDIT_TOOLS = new Set(["edit", "apply_patch", "patch"])
const SHELL_TOOLS = new Set(["bash", "shell"])

const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : []
}

function inputPath(part: ToolPart) {
  const input = object(part.state.input)
  const metadata = "metadata" in part.state ? object(part.state.metadata) : {}
  const filediff = object(metadata.filediff)
  const one = [input.filePath, input.path, input.file, input.filename, filediff.file].find(
    (value) => typeof value === "string" && value.trim(),
  )
  return typeof one === "string" ? one : undefined
}

function readPaths(part: ToolPart) {
  const input = object(part.state.input)
  const metadata = "metadata" in part.state ? object(part.state.metadata) : {}
  const values = [
    input.filePath,
    input.path,
    input.file,
    input.filename,
    ...strings(input.paths),
    ...strings(input.filePaths),
    ...strings(metadata.loaded),
    ...strings(metadata.files),
  ]
  return [...new Set(values.filter((value): value is string => typeof value === "string" && !!value.trim()))]
}

function changeCounts(part: ToolPart) {
  const state = part.state as any
  const metadata = object(state.metadata)
  const filediff = object(metadata.filediff)
  const files = Array.isArray(metadata.files) ? metadata.files.map(object) : []
  const additions = Number.isFinite(filediff.additions)
    ? Number(filediff.additions)
    : files.reduce((sum, item) => sum + (Number.isFinite(item.additions) ? Number(item.additions) : 0), 0)
  const deletions = Number.isFinite(filediff.deletions)
    ? Number(filediff.deletions)
    : files.reduce((sum, item) => sum + (Number.isFinite(item.deletions) ? Number(item.deletions) : 0), 0)
  return {
    additions: additions > 0 ? additions : undefined,
    deletions: deletions > 0 ? deletions : undefined,
  }
}

function command(part: ToolPart) {
  const state = part.state as unknown as { input?: unknown; title?: string }
  const input = object(state.input)
  return String(input.command ?? input.cmd ?? input.script ?? state.title ?? part.tool)
}

export function inlineDiffPreview(part: ToolPart, limit = 4) {
  const metadata = object((part.state as any).metadata)
  const diff = typeof metadata.diff === "string" ? metadata.diff : undefined
  if (diff) {
    return diff
      .split(/\r?\n/)
      .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))
      .slice(0, limit)
  }
  const filediff = object(metadata.filediff)
  const before = typeof filediff.before === "string" ? filediff.before.split(/\r?\n/).filter(Boolean) : []
  const after = typeof filediff.after === "string" ? filediff.after.split(/\r?\n/).filter(Boolean) : []
  return [
    ...before.slice(0, Math.max(1, Math.floor(limit / 2))).map((line) => `-${line}`),
    ...after.slice(0, Math.max(1, Math.ceil(limit / 2))).map((line) => `+${line}`),
  ].slice(0, limit)
}

function testStep(part: ToolPart): SessionToolStep {
  const result = turnTestResult([part])
  return {
    id: part.id,
    partIDs: [part.id],
    kind: "test",
    command: command(part),
    status: result.status === "not-run" ? "passed" : result.status,
    count: result.count,
    durationMs: result.durationMs,
  }
}

/** Condenses normal file/search/test calls into the compact timeline rows from session mockup 02. */
export function sessionToolSteps(parts: Part[]) {
  const out: SessionToolStep[] = []
  for (const part of parts) {
    if (part.type !== "tool") continue
    const tool = part.tool.toLowerCase()
    if (READ_TOOLS.has(tool)) {
      const paths = readPaths(part)
      const current = out.at(-1)
      if (current?.kind === "read") {
        current.partIDs.push(part.id)
        current.paths = [...new Set([...current.paths, ...paths])]
        current.count = current.paths.length > 0 ? current.paths.length : current.count + 1
      } else {
        out.push({ id: part.id, partIDs: [part.id], kind: "read", paths, count: Math.max(1, paths.length) })
      }
      continue
    }
    if (EDIT_TOOLS.has(tool) || tool === "write") {
      const changes = changeCounts(part)
      out.push({
        id: part.id,
        partIDs: [part.id],
        kind: tool === "write" ? "write" : "edit",
        path: inputPath(part) ?? "",
        ...changes,
      })
      continue
    }
    if (SHELL_TOOLS.has(tool) && isTestCommand(part)) {
      out.push(testStep(part))
      continue
    }
    if (SHELL_TOOLS.has(tool)) out.push({ id: part.id, partIDs: [part.id], kind: "shell", command: command(part) })
  }
  return out
}

export function formatStepDuration(ms: number | undefined, locale: string) {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) {
    const number = new Intl.NumberFormat(locale.toLowerCase().startsWith("id") ? "id-ID" : "en-US", {
      minimumFractionDigits: seconds % 1 === 0 ? 0 : 1,
      maximumFractionDigits: 1,
    }).format(seconds)
    return number
  }
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}m ${remainder}s`
}
