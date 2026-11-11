import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import timers from "node:timers/promises"
import { Global } from "@opencode-ai/core/global"
import { classify } from "@opencode-ai/core/ezk/router/classify"
import { gitHead } from "@opencode-ai/core/ezk/codeintel/files"
import { CodeIndex, type GraphRows, MAX_HITS, type SyncResult, formatCodeHits, indexFile } from "@opencode-ai/core/ezk/codeintel/index"
import { type RepoMap, buildRepoMap, mentionedFiles, mentionedIdentifiers } from "@opencode-ai/core/ezk/codeintel/repomap"
import { projectTrusted } from "@/config/trust"
import { PartID } from "@/session/schema"
import { CODE_INDEX_WORKER_TIMEOUT_MS, runCodeIndexWorkerProcess } from "@/ezk/codeintel-process"
import type { CodeIndexWorkerMessage } from "@/ezk/codeintel-worker"
import { ezkRuntime } from "./runtime"

// Ezkielyna Agent v3 (Wave C, codeintel): thin glue between OpenCode hooks and core/src/ezk/codeintel/*.
//   tool `code_search`  -> FTS5 search over paths, symbols and doc comments (flag ezk.codesearch, default off)
//   config              -> lets the read-only Explore subagent call `code_search` (its tool list only)
//   chat.message        -> on heavy turns in big git repos, one repo-map reminder part on the user message
//                          (flag ezk.repomap, default off); it is saved with the message, so the prompt prefix of
//                          later turns never changes and the system prompt is untouched
//   tool.execute.after  -> remembers the files a session read or edited (repo map personalisation)
// The index is queried from the server process and built lazily in a short-lived child process; there is no watcher.

const RESYNC_MS = 10_000
// How long a caller waits for a running (re)build. The build itself is one bounded run that keeps going in the
// background if the caller stops waiting; it is never restarted while it runs and nothing watches the files.
const SEARCH_WAIT_MS = 20_000
const MAP_WAIT_MS = 5_000
const MAX_TRACKED = 300
const MAX_TOUCHED = 50
const MAX_MAPS = 20

interface Project {
  file: string
  index?: CodeIndex
  reader?: Promise<CodeIndex>
  syncedAt: number
  last?: SyncResult
  syncing?: Promise<SyncResult | undefined>
  progress?: { parsed: number; total: number }
  graph?: { key: string; rows: GraphRows }
  sessions: Set<string>
  cancel?: () => void
  error?: string
}

export function codeIntel(
  dataDir: string,
  opts: { workerTimeoutMs?: number; resyncMs?: number; onWorkerSpawn?: (pid: number | undefined) => void } = {},
) {
  const projects = new Map<string, Project>()
  const maps = new Map<string, RepoMap>()
  const onExit = () => {
    for (const p of projects.values()) p.cancel?.()
  }
  process.once("exit", onExit)

  const project = (root: string) => {
    const existing = projects.get(root)
    if (existing) return existing
    const created: Project = { file: indexFile(dataDir, root), syncedAt: 0, sessions: new Set() }
    projects.set(root, created)
    return created
  }

  async function openReader(p: Project, root: string) {
    if (p.index) return p.index
    p.reader ??= CodeIndex.openReadOnly(p.file, root).then((index) => (p.index = index))
    try {
      return await p.reader
    } catch (error) {
      p.reader = undefined
      throw error
    }
  }

  function startBuild(p: Project, root: string) {
    if (p.syncing) return p.syncing
    p.progress = undefined
    p.error = undefined
    if (fs.existsSync(p.file)) void openReader(p, root).catch(() => {})

    p.syncing = (async () => {
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        const worker = runCodeIndexWorkerProcess(
          { file: p.file, root, git: projectTrusted(root), batchSize: 24 },
          {
            onSpawn: opts.onWorkerSpawn,
            onMessage: (message: CodeIndexWorkerMessage) => {
              if (message.type === "ready") {
                void openReader(p, root).catch(() => {})
              }
              if (message.type === "progress") p.progress = { parsed: message.parsed, total: message.total }
            },
          },
          { timeoutMs: opts.workerTimeoutMs ?? CODE_INDEX_WORKER_TIMEOUT_MS },
        )
        p.cancel = worker.cancel
        try {
          return await worker.promise
        } catch (error) {
          lastError = error
          const reason = error instanceof Error ? error : new Error(String(error))
          if (reason.name === "AbortError" || /timed out after/.test(reason.message) || attempt === 1) throw reason
        } finally {
          if (p.cancel === worker.cancel) p.cancel = undefined
        }
      }
      throw lastError
    })()
      .then((result) => {
        p.last = result
        p.syncedAt = Date.now()
        p.error = undefined
        if (result?.parsed || result?.removed) p.graph = undefined
        return result
      })
      .catch((error) => {
        p.error = error instanceof Error ? error.message : String(error)
        return undefined
      })
      .finally(() => {
        p.syncing = undefined
        p.progress = undefined
        p.cancel = undefined
      })
    return p.syncing
  }

  /** `result` is undefined while a child build is still running after `waitMs`. */
  async function sync(root: string, waitMs: number, sessionID?: string, signal?: AbortSignal) {
    const p = project(root)
    if (sessionID) p.sessions.add(sessionID)
    if (p.last?.done && Date.now() - p.syncedAt < (opts.resyncMs ?? RESYNC_MS)) {
      const index = p.index ?? (await openReader(p, root))
      return { index, result: p.last, fresh: false, progress: undefined, error: undefined }
    }

    const task = startBuild(p, root)
    const stop = new AbortController()
    const timer = timers.setTimeout(waitMs, undefined, { signal: stop.signal }).catch(() => undefined)
    const onAbort = () => {
      if (p.sessions.size <= 1) p.cancel?.()
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    const result = await Promise.race([task, timer])
    signal?.removeEventListener("abort", onAbort)
    stop.abort()
    let index = p.index
    if (!index) {
      const readerReady = p.reader
      if (readerReady) index = await readerReady.catch(() => undefined)
    }
    if (!index && fs.existsSync(p.file)) index = await openReader(p, root).catch(() => undefined)
    if (!index && p.syncing) {
      const readyWait = new AbortController()
      const wait = timers.setTimeout(Math.min(waitMs, 1000), undefined, { signal: readyWait.signal }).catch(() => undefined)
      await Promise.race([p.reader, wait])
      readyWait.abort()
      index = p.index
    }
    return { index, result, fresh: true, progress: p.progress, error: p.error }
  }

  return {
    sync,

    async search(root: string, query: string, limit = MAX_HITS, sessionID?: string, signal?: AbortSignal) {
      const { index, result, fresh, progress, error } = await sync(root, SEARCH_WAIT_MS, sessionID, signal)
      const hits = index?.search(query, limit) ?? []
      const note = error
        ? `(code index worker failed: ${error}; search again to retry)`
        : !result
          ? `(mengindeks…${progress ? ` ${progress.parsed} dari ${progress.total} file` : ""}; hasil sementara, cari lagi nanti)`
          : fresh && result.parsed > 50
          ? `(code index updated: ${result.parsed} of ${result.files} files in ${result.ms} ms)`
          : undefined
      return { hits, note, result }
    },

    /** A repo map, or undefined when the repo is small, the index is not ready within the budget, or nothing ranks. */
    async repoMap(root: string, input: { head: string; text: string; chatFiles: Iterable<string>; tokens: number; minFiles: number; sessionID?: string }) {
      const { index, result } = await sync(root, MAP_WAIT_MS, input.sessionID)
      if (!index || !result?.done || result.files <= input.minFiles) return undefined
      const p = project(root)
      if (p.graph?.key !== input.head) p.graph = { key: input.head, rows: index.graph() }
      const rows = p.graph.rows
      const chat = new Set([...input.chatFiles, ...mentionedFiles(input.text, rows.files)])
      const defined = new Set(rows.defs.map((d) => d.name))
      const idents = [...mentionedIdentifiers(input.text)].filter((w) => defined.has(w))
      const key = [root, input.head, input.tokens, [...chat].sort().join(","), idents.sort().join(",")].join("\0")
      const cached = maps.get(key)
      if (cached) return cached
      const map = buildRepoMap({ graph: rows, chatFiles: chat, mentionedIdents: idents, maxTokens: input.tokens })
      maps.set(key, map)
      if (maps.size > MAX_MAPS) maps.delete(maps.keys().next().value!)
      return map
    },

    async close() {
      process.off("exit", onExit)
      for (const p of projects.values()) p.cancel?.()
      await Promise.all([...projects.values()].map((p) => p.syncing?.catch(() => undefined)))
      await Promise.all([...projects.values()].map((p) => p.reader?.catch(() => undefined)))
      for (const p of projects.values()) p.index?.close()
      projects.clear()
      maps.clear()
    },

    endSession(sessionID: string) {
      for (const p of projects.values()) {
        p.sessions.delete(sessionID)
        if (p.sessions.size === 0) p.cancel?.()
      }
    },

    cancelAll() {
      for (const p of projects.values()) p.cancel?.()
    },
  }
}

export type CodeIntel = ReturnType<typeof codeIntel>

let service: CodeIntel | undefined
export const ezkCodeIntel = () => (service ??= codeIntel(Global.Path.data))
export const resetEzkCodeIntel = async () => {
  await service?.close()
  service = undefined
}

export const CODE_SEARCH_DESCRIPTION =
  "Find code by name or concept in this project: ranked search over file paths, symbol names (functions, classes, methods, types), signatures and doc comments. Use it for 'where is X defined or handled?' before grep. Returns up to 20 lines `path:line  kind  name  signature`."

export function repoMapReminder(map: string) {
  return `<system-reminder>\nRepository map: the files and definitions most related to this task, ranked (signatures only; read a file before editing it).\n${map}\n</system-reminder>`
}

export async function EzkCodeIntelPlugin(input: PluginInput): Promise<Hooks> {
  const rt = ezkRuntime()
  if (!rt.flags.codesearch.enabled && !rt.flags.repomap.enabled) return {}
  const touched = new Map<string, Set<string>>()
  const injected = new Map<string, string>()
  const rootOf = (worktree: string, directory: string) => path.resolve(worktree && worktree !== "/" ? worktree : directory)
  const root = rootOf(input.worktree, input.directory)

  const hooks: Hooks = {
    async dispose() {
      await resetEzkCodeIntel()
    },
    async event({ event }) {
      const e = event as { type: string; properties?: { info?: { id?: string }; sessionID?: string } }
      if (e.type !== "session.deleted") return
      const sessionID = e.properties?.info?.id ?? e.properties?.sessionID
      if (sessionID) service?.endSession(sessionID)
    },
    async "tool.execute.after"(inp) {
      const file = inp.args?.filePath
      if (typeof file !== "string") return
      const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join("/")
      if (rel.startsWith("..") || path.isAbsolute(rel)) return
      let set = touched.get(inp.sessionID)
      if (!set) {
        touched.set(inp.sessionID, (set = new Set()))
        if (touched.size > MAX_TRACKED) touched.delete(touched.keys().next().value!)
      }
      set.delete(rel)
      set.add(rel)
      if (set.size > MAX_TOUCHED) set.delete(set.values().next().value!)
    },
  }

  if (rt.flags.codesearch.enabled) {
    hooks.tool = {
      code_search: tool({
        description: CODE_SEARCH_DESCRIPTION,
        args: {
          query: tool.schema.string().describe("names or words to find"),
          limit: tool.schema.number().int().min(1).max(MAX_HITS).optional(),
        },
        async execute(args, ctx) {
          const { hits, note } = await ezkCodeIntel().search(
            rootOf(ctx.worktree, ctx.directory),
            args.query,
            args.limit ?? MAX_HITS,
            ctx.sessionID,
            ctx.abort,
          )
          const body = hits.length ? formatCodeHits(hits) : "No matches. Try other words, or grep for exact text."
          return note ? `${note}\n${body}` : body
        },
      }),
    }
    // Explore is "*": "deny" with an allow list; adding one entry keeps it read-only. A user's own setting wins.
    hooks.config = async (cfg: any) => {
      cfg.agent ??= {}
      cfg.agent.explore ??= {}
      const explore = cfg.agent.explore
      if (typeof explore.permission === "string") return
      explore.permission ??= {}
      explore.permission.code_search ??= "allow"
    }
  }

  if (rt.flags.repomap.enabled) {
    hooks["chat.message"] = async (_inp, out) => {
      const msg = out.message
      const parts = out.parts as any[]
      const text = parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text as string).join("\n")
      if (!text.trim()) return
      if (classify({ prompt: text, planMode: msg.agent === "plan", ...rt.signals.snapshot(msg.sessionID) }).tier !== "heavy") return
      const head = gitHead(root)
      // One map per session per commit: it stays in the history, so a second one would only repeat it.
      if (!head || injected.get(msg.sessionID) === head) return
      const attached = parts.flatMap((p) => (p.type === "file" && typeof p.source?.path === "string" ? [p.source.path as string] : []))
      const chatFiles = [...(touched.get(msg.sessionID) ?? []), ...attached.map((f) => path.relative(root, path.resolve(root, f)).split(path.sep).join("/"))]
      const map = await ezkCodeIntel()
        .repoMap(root, { head, text, chatFiles, tokens: rt.flags.repomap.tokens, minFiles: rt.flags.repomap.minFiles, sessionID: msg.sessionID })
        .catch(() => undefined)
      if (!map?.text) return
      injected.set(msg.sessionID, head)
      if (injected.size > MAX_TRACKED) injected.delete(injected.keys().next().value!)
      parts.push({ id: PartID.ascending(), sessionID: msg.sessionID, messageID: msg.id, type: "text", synthetic: true, text: repoMapReminder(map.text) })
    }
  }

  return hooks
}
