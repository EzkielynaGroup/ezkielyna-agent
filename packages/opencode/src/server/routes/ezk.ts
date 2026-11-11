// Ezkielyna Agent v1.1: raw JSON routes under /ezk/* for the TUI and Desktop renderers (and the e2e tests).
// Renderers only display these payloads. Auth is the normal server auth (router middleware, like /doc).
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { MemoryStatus, RouterStatus } from "@opencode-ai/core/ezk/contracts"
import { Global } from "@opencode-ai/core/global"
import { ezkSafetyRoutes } from "./ezk-safety"

const json = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status })

const query = (url: string, name: string) => new URL(url, "http://local").searchParams.get(name) ?? undefined

async function getRuntime() {
  return (await import("@/plugin/ezk/runtime")).ezkRuntime()
}

export async function routerStatus(): Promise<RouterStatus> {
  const rt = await getRuntime()
  return {
    enabled: rt.flags.router.enabled,
    aliases: rt.engine.allowed.aliases,
    allowed: [...rt.engine.allowed.ids],
    breakers: rt.engine.breaker.open(),
    capUSD: rt.flags.router.capUSD,
    spentUSD: 0,
    proVisible: rt.pro.visible(),
  }
}

export async function memoryStatus(sessionID?: string): Promise<MemoryStatus> {
  const [{ LIMITS }, rt] = await Promise.all([
    import("@opencode-ai/core/ezk/memory/store"),
    getRuntime(),
  ])
  const state = rt.memState.get()
  const view = (kind: "memory" | "user") => ({ chars: rt.memory.chars(kind), limit: LIMITS[kind], entries: rt.memory.load(kind) })
  return {
    enabled: rt.flags.memory.enabled,
    noticeAccepted: state.noticeAccepted,
    private: !!sessionID && state.privateSessions.includes(sessionID),
    reviewEnabled: rt.flags.memory.review,
    memory: view("memory"),
    user: view("user"),
    dir: rt.memory.dir,
    profile: process.env.EZK_PROFILE?.trim() || "default",
    lastReview: rt.lastReview,
  }
}

const body = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(Effect.map((v) => (v && typeof v === "object" ? (v as Record<string, any>) : {})), Effect.orElseSucceed(() => ({}) as Record<string, any>))

export const ezkRoutes = <A, E, R>(authLayer: Layer.Layer<A, E, R>) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* ezkSafetyRoutes(router) // Wave B safety: /ezk/permission, /ezk/trust, /ezk/hooks
      yield* router.add("GET", "/ezk/router/status", (request) =>
        Effect.gen(function* () {
          const status = yield* Effect.promise(() => routerStatus())
          const sessionID = query(request.url, "sessionID")
          if (sessionID) {
            const [{ restoreSessionCosts }, rt] = yield* Effect.promise(() => Promise.all([
              import("@/plugin/ezk/runtime"),
              getRuntime(),
            ]))
            yield* Effect.tryPromise(() => restoreSessionCosts(rt, sessionID)).pipe(Effect.ignore)
            status.spentUSD = rt.engine.spentUSD(sessionID)
          }
          return json(status)
        }),
      )
      yield* router.add("GET", "/ezk/router/turns", (request) => {
        const sessionID = query(request.url, "sessionID")
        if (!sessionID) return Effect.succeed(json({ error: "sessionID required" }, 400))
        return Effect.promise(async () => json((await getRuntime()).turns.forSession(sessionID)))
      })

      yield* router.add("GET", "/ezk/search", (request) =>
        Effect.gen(function* () {
          const q = query(request.url, "q")
          if (!q) return json({ error: "q required" }, 400)
          if (!(yield* Effect.promise(() => getRuntime())).flags.search.enabled) return json({ hits: [] })
          const limit = Number(query(request.url, "limit") ?? 10)
          const sessionID = query(request.url, "exclude")
          const directory = query(request.url, "directory")
          const projectSessionID = query(request.url, "projectSessionID") ?? sessionID
          const { ezkSearch } = yield* Effect.promise(() => import("@/plugin/ezk/search"))
          return yield* Effect.tryPromise(() => ezkSearch().query(q, {
            limit: Number.isFinite(limit) ? limit : 10,
            excludeSession: sessionID,
            projectSessionID,
            projectDirectory: directory,
            // This route serves the user's own Search dialog. Opened from the home screen it has no session or folder to scope to,
            // and an empty scope used to return nothing; then it searches every project (the model's session_search tool never takes this path).
            allProjects: !projectSessionID && !directory,
          })).pipe(
            Effect.map((r) => json({ hits: r.hits, builtMs: r.builtMs })),
            Effect.catch((e: unknown) => Effect.succeed(json({ error: `search failed: ${String((e as any)?.cause ?? e)}` }, 500))),
          )
        }),
      )
      yield* router.add("GET", "/ezk/memory", (request) => Effect.promise(() => memoryStatus(query(request.url, "sessionID"))).pipe(Effect.map(json)))
      yield* router.add("POST", "/ezk/memory/notice", () => {
        return Effect.promise(async () => {
          ;(await getRuntime()).memState.acceptNotice()
          return json({ ok: true })
        })
      })
      yield* router.add("POST", "/ezk/memory/private", (request) =>
        Effect.gen(function* () {
          const b = yield* body(request)
          if (typeof b.sessionID !== "string" || !b.sessionID) return json({ error: "sessionID required" }, 400)
          const rt = yield* Effect.promise(() => getRuntime())
          rt.memState.setPrivate(b.sessionID, b.on !== false)
          rt.frozen.delete(b.sessionID)
          if (b.on !== false) {
            const { ezkSearch } = yield* Effect.promise(() => import("@/plugin/ezk/search"))
            yield* Effect.promise(() => ezkSearch().forget(b.sessionID)).pipe(Effect.ignore)
          }
          return json(yield* Effect.promise(() => memoryStatus(b.sessionID)))
        }),
      )
      yield* router.add("POST", "/ezk/memory/op", (request) =>
        Effect.gen(function* () {
          const b = yield* body(request)
          const rt = yield* Effect.promise(() => getRuntime())
          if (!["memory", "user"].includes(b.store) || !["add", "replace", "remove"].includes(b.action)) return json({ error: "bad request" }, 400)
          const r =
            b.action === "add"
              ? rt.memory.add(b.store, String(b.text ?? ""))
              : b.action === "replace"
                ? rt.memory.replace(b.store, String(b.match ?? ""), String(b.text ?? ""))
                : rt.memory.remove(b.store, String(b.match ?? ""))
          return json(r, r.ok ? 200 : 422)
        }),
      )
      yield* router.add("POST", "/ezk/memory/wipe", (request) =>
        Effect.gen(function* () {
          const b = yield* body(request)
          if (b.confirm !== true) return json({ error: "confirm:true required" }, 400)
          const rt = yield* Effect.promise(() => getRuntime())
          const [{ resetEzkSearch }, { wipeMemory }] = yield* Effect.promise(() => Promise.all([
            import("@/plugin/ezk/search"),
            import("@opencode-ai/core/ezk/wipe"),
          ]))
          resetEzkSearch()
          const report = wipeMemory({ config: Global.Path.config, data: Global.Path.data })
          rt.frozen.clear()
          rt.reviewTurns.clear()
          rt.reviewExplicit.clear()
          rt.lastReview = undefined
          return json(report)
        }),
      )
      // Ezkielyna Agent: always registered. /ezk/exec, /ezk/context and /ezk/usage answer {enabled:false} when their flag is off
      // (diagnostics is default ON), so the routes must exist; the module itself is still imported lazily.
      const { execLaneRoutes } = yield* Effect.promise(() => import("@/ezk/routes"))
      yield* execLaneRoutes(router, { json, query, body })
    }),
  ).pipe(Layer.provide(authLayer))
