import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import type { SearchHit } from "@opencode-ai/core/ezk/contracts"
import type { SearchIndex } from "@opencode-ai/core/ezk/search/fts"
import { ezkPaths } from "@opencode-ai/core/ezk/wipe"
import { type EzkRuntime, ezkRuntime } from "./runtime"

// Ezkielyna Agent v1.1: FTS5 session search. Index = separate additive file <data>/ezk/search.db, built lazily on the
// first search (ms-level incremental syncs at most every 20 s afterwards). Private sessions are never indexed or returned.

const SYNC_EVERY_MS = 20_000
const OUTPUT_CAP = 4000

export type SearchResultView = SearchHit

export function searchService(rt: EzkRuntime) {
  let idx: SearchIndex | undefined
  let opening: Promise<SearchIndex> | undefined
  let lastSync = 0
  let syncing: Promise<void> | undefined

  const paths = ezkPaths({ config: Global.Path.config, data: Global.Path.data })
  const open = () => {
    if (!opening) {
      opening = import("@opencode-ai/core/ezk/search/fts")
        .then(({ SearchIndex }) => SearchIndex.open(paths.searchDb))
        .then((i) => (idx = i))
        .catch((err) => {
          opening = undefined
          throw err
        })
    }
    return opening
  }

  async function projectSessions(input: { sessionID?: string; directory?: string }): Promise<Set<string>> {
    const file = Database.path()
    if (file === ":memory:" || !fs.existsSync(file)) return new Set()
    if (!input.sessionID && !input.directory) return new Set()
    const src = await (await import("@opencode-ai/core/ezk/search/sqlite")).openSqlite(file, { readonly: true })
    try {
      const rows = input.sessionID
        ? src.all<{ id: string }>(
            `SELECT s.id FROM session s
              WHERE s.project_id = (SELECT project_id FROM session WHERE id = ?)
                AND (s.project_id <> 'global' OR s.directory = (SELECT directory FROM session WHERE id = ?))`,
            input.sessionID,
            input.sessionID,
          )
        : (() => {
            const root = path.resolve(input.directory!)
            return src.all<{ id: string }>(
              "SELECT s.id FROM session s JOIN project p ON p.id = s.project_id WHERE p.worktree = ? OR s.directory = ?",
              root,
              root,
            )
          })()
      return new Set(rows.map((row) => row.id))
    } catch {
      return new Set()
    } finally {
      src.close()
    }
  }

  async function sync(): Promise<{ builtMs?: number }> {
    const index = await open()
    if (Date.now() - lastSync < SYNC_EVERY_MS) return {}
    if (syncing) {
      await syncing
      return {}
    }
    const first = index.count() === 0
    const t0 = performance.now()
    syncing = (async () => {
      const file = Database.path()
      if (file !== ":memory:" && !fs.existsSync(file)) return
      const src = await (await import("@opencode-ai/core/ezk/search/sqlite")).openSqlite(file, { readonly: true })
      try {
        const profile = process.env.EZK_PROFILE?.trim()
        index.sync(src, {
          skipSessions: new Set(rt.memState.get().privateSessions),
          onlySessions: profile ? new Set(rt.memState.get().profileSessions) : undefined,
          batch: 5000,
        })
      } finally {
        src.close()
      }
      lastSync = Date.now()
    })().finally(() => (syncing = undefined))
    await syncing
    return first ? { builtMs: Math.round(performance.now() - t0) } : {}
  }

  async function titles(ids: string[]): Promise<Map<string, { title: string; directory: string }>> {
    const out = new Map<string, { title: string; directory: string }>()
    if (!ids.length) return out
    try {
      const src = await (await import("@opencode-ai/core/ezk/search/sqlite")).openSqlite(Database.path(), { readonly: true })
      try {
        for (const r of src.all<{ id: string; title: string; directory: string }>(`SELECT id, title, directory FROM session WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids)) out.set(r.id, { title: r.title, directory: r.directory })
      } finally {
        src.close()
      }
    } catch {}
    return out
  }

  return {
    async query(q: string, opts: { limit?: number; sessionID?: string; excludeSession?: string; projectSessionID?: string; projectDirectory?: string; allProjects?: boolean } = {}) {
      const { builtMs } = await sync()
      const index = await open()
      const priv = new Set(rt.memState.get().privateSessions)
      if (opts.excludeSession) priv.add(opts.excludeSession)
      let includeSessions: Set<string> | undefined
      if (!opts.allProjects) includeSessions = await projectSessions({ sessionID: opts.projectSessionID, directory: opts.projectDirectory })
      if (includeSessions && process.env.EZK_PROFILE?.trim()) {
        const profileSessions = new Set(rt.memState.get().profileSessions)
        includeSessions = new Set([...includeSessions].filter((id) => profileSessions.has(id)))
      }
      const hits = index.search(q, { limit: opts.limit, sessionID: opts.sessionID, excludeSessions: priv, includeSessions })
      const t = await titles([...new Set(hits.map((h) => h.sessionID))])
      return { hits: hits.map((h): SearchResultView => ({ ...h, title: t.get(h.sessionID)?.title, directory: t.get(h.sessionID)?.directory })), builtMs }
    },
    async forget(sessionID: string) {
      if (idx || fs.existsSync(ezkPaths({ config: Global.Path.config, data: Global.Path.data }).searchDb)) (await open()).forgetSession(sessionID)
    },
    close() {
      idx?.close()
      idx = opening = undefined
      lastSync = 0
    },
  }
}

export type SearchService = ReturnType<typeof searchService>

let service: SearchService | undefined
export const ezkSearch = () => (service ??= searchService(ezkRuntime()))
export const resetEzkSearch = () => {
  service?.close()
  service = undefined
}

export function formatHits(hits: SearchResultView[], builtMs?: number) {
  if (!hits.length) return "No matches in past sessions."
  const lines = hits.map((h) => {
    const date = new Date(h.time).toISOString().slice(0, 10)
    return `- [${h.title ?? h.sessionID}] ${date} ${h.role}: ${h.snippet.replace(/\s+/g, " ")} (session ${h.sessionID}, message ${h.messageID})`
  })
  let text = lines.join("\n")
  if (text.length > OUTPUT_CAP) text = text.slice(0, OUTPUT_CAP) + "\n…"
  return builtMs !== undefined ? `(search index built in ${builtMs} ms)\n${text}` : text
}

export async function EzkSearchPlugin(_input: PluginInput): Promise<Hooks> {
  const rt = ezkRuntime()
  if (!rt.flags.search.enabled) return {}
  return {
    tool: {
      session_search: tool({
        description: "Full-text search of past sessions in this project. Set allProjects only when the user explicitly wants cross-project results; that request will require approval.",
        args: {
          query: tool.schema.string().describe("words to find"),
          limit: tool.schema.number().int().min(1).max(10).optional(),
          allProjects: tool.schema.boolean().optional().describe("search sessions across projects; requires user approval"),
        },
        async execute(args, ctx) {
          if (rt.memState.isPrivate(ctx.sessionID)) return "Private session: search is off."
          if (args.allProjects) {
            await ctx.ask({
              permission: "ezk_session_search_all",
              patterns: ["cross-project session search"],
              always: [],
              metadata: { query: args.query },
            })
          }
          const { hits, builtMs } = await ezkSearch().query(args.query, {
            limit: args.limit ?? 6,
            excludeSession: ctx.sessionID,
            projectSessionID: ctx.sessionID,
            allProjects: args.allProjects,
          })
          return formatHits(hits, builtMs)
        },
      }),
    },
    async "chat.message"(_input, out) {
      if (process.env.EZK_PROFILE?.trim()) rt.memState.markProfileSession(out.message.sessionID)
    },
  }
}
