// Ezkielyna Wave B "exec" lane: JSON routes for the TUI and desktop, mounted from server/routes/ezk.ts with one line.
//   GET  /ezk/exec?sessionID=      background commands of that session (T2), newest first (no sessionID: empty list)
//   GET  /ezk/exec/output?id=&sessionID=   stored output of one command (head + tail); the command must belong to the session
//   POST /ezk/exec/stop {id, sessionID}    stop one command and its process tree (same ownership check; JSON content-type only)
//   GET  /ezk/context?sessionID=   what fills the context window (U4 /context)
//   GET  /ezk/status?directory=&sessionID=&model=  real sandbox state, web search, prices, agentContext (desktop chips)
//   GET  /ezk/usage?sessionID=     tokens, cost, cache hit and likely miss cause (U4 /usage, status line)
import { Effect } from "effect"
import type { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import { execManager } from "@opencode-ai/core/ezk/exec/manager"
import { type ExecTasksResponse, lastLines } from "@opencode-ai/core/ezk/exec/contracts"
import { contextFor, usageFor } from "./diag"
import { statusFor } from "./status"
import { buildBugReport, reportDependencies } from "./bugreport"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { accountLookup } from "./account"

type Helpers = {
  json: (value: unknown, status?: number) => HttpServerResponse.HttpServerResponse
  query: (url: string, name: string) => string | undefined
  body: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Record<string, any>>
}

export function isJsonRequest(contentType: string | undefined) {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase()
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"))
}

export const execLaneRoutes = Effect.fn("EzkExecLane.routes")(function* (router: HttpRouter.HttpRouter, h: Helpers) {
  yield* router.add("GET", "/ezk/exec", (request) =>
    Effect.sync(() => {
      const enabled = execEnabled("exec")
      if (!enabled) return h.json({ enabled, tasks: [] } satisfies ExecTasksResponse)
      const manager = execManager()
      // Never list every session's commands: without a session there is nothing to show.
      const sessionID = h.query(request.url, "sessionID")
      if (!sessionID) return h.json({ enabled, tasks: [] } satisfies ExecTasksResponse)
      const tasks = manager
        .list(sessionID)
        .toSorted((a, b) => b.startedAt - a.startedAt)
        .map((info) => ({ ...info, preview: lastLines(manager.output(info.id)) }))
      return h.json({ enabled, tasks } satisfies ExecTasksResponse)
    }),
  )
  yield* router.add("GET", "/ezk/exec/output", (request) =>
    Effect.sync(() => {
      const id = h.query(request.url, "id")
      const sessionID = h.query(request.url, "sessionID")
      if (!sessionID) return h.json({ error: "sessionID required" }, 400)
      const info = id ? execManager().get(id) : undefined
      if (!id || !info || info.owner !== sessionID) return h.json({ error: "unknown id" }, 404)
      return h.json({ id, output: execManager().output(id) })
    }),
  )
  yield* router.add("POST", "/ezk/exec/stop", (request) =>
    Effect.gen(function* () {
      // A cross-origin page can send a "simple" POST (text/plain, form) without a preflight; only real JSON gets through.
      if (!isJsonRequest(request.headers["content-type"])) return h.json({ error: "content-type must be application/json" }, 415)
      const b = yield* h.body(request)
      const id = typeof b.id === "string" ? b.id : ""
      const sessionID = typeof b.sessionID === "string" ? b.sessionID : ""
      if (!sessionID) return h.json({ error: "sessionID required" }, 400)
      const info = execManager().get(id)
      if (!info || info.owner !== sessionID) return h.json({ error: "unknown id" }, 404)
      return h.json({ ok: true, task: execManager().stop(id) })
    }),
  )
  yield* router.add("GET", "/ezk/context", (request) =>
    Effect.gen(function* () {
      const sessionID = h.query(request.url, "sessionID")
      if (!sessionID) return h.json({ error: "sessionID required" }, 400)
      if (!execEnabled("diagnostics")) return h.json({ enabled: false })
      const breakdown = yield* Effect.promise(() => contextFor(sessionID))
      return h.json({ enabled: true, breakdown: breakdown ?? null })
    }),
  )
  yield* router.add("GET", "/ezk/usage", (request) =>
    Effect.gen(function* () {
      const sessionID = h.query(request.url, "sessionID")
      if (!sessionID) return h.json({ error: "sessionID required" }, 400)
      if (!execEnabled("diagnostics")) return h.json({ enabled: false, statusline: false })
      const usage = yield* Effect.promise(() => usageFor(sessionID))
      return h.json({ enabled: true, statusline: execEnabled("statusline"), ...usage })
    }),
  )
  yield* router.add("GET", "/ezk/bugreport", (request) =>
    Effect.gen(function* () {
      if (!execEnabled("diagnostics")) return h.json({ enabled: false })
      const report = yield* Effect.promise(() => buildBugReport(reportDependencies(detectLang(), process.cwd(), h.query(request.url, "model"))))
      return h.json({ enabled: true, report })
    }),
  )
  yield* router.add("GET", "/ezk/status", (request) =>
    Effect.gen(function* () {
      const directory = h.query(request.url, "directory")
      if (!directory) return h.json({ error: "directory required" }, 400)
      const status = yield* Effect.promise(() =>
        statusFor({ directory, sessionID: h.query(request.url, "sessionID"), model: h.query(request.url, "model") }),
      )
      return h.json(status)
    }),
  )
  yield* router.add("GET", "/ezk/account", () =>
    Effect.promise(() => accountLookup()).pipe(Effect.map((result) => h.json(result))),
  )
})
