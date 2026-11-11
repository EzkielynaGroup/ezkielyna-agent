// Ezkielyna Agent v3 "ux" lane: raw JSON routes under /ezk/ux/* for the TUI and Desktop (rewind, plan approval,
// handoff, feature status). Same auth as the other /ezk routes. Each request runs in the session's project instance.
import { Cause, Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { loadFlags } from "@opencode-ai/core/ezk/flags"
import { Global } from "@opencode-ai/core/global"
import type { RewindMode } from "@opencode-ai/core/ezk/ux/checkpoints"
import type { ApprovalMode } from "@opencode-ai/core/ezk/ux/plan"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"

const json = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status })
const query = (url: string, name: string) => new URL(url, "http://local").searchParams.get(name) ?? undefined
const body = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(
    Effect.map((v) => (v && typeof v === "object" ? (v as Record<string, any>) : {})),
    Effect.orElseSucceed(() => ({}) as Record<string, any>),
  )
const lang = (v: unknown) => (v === "id" ? ("id" as const) : ("en" as const))
const validSession = (v: unknown): v is string => typeof v === "string" && /^ses_[\w-]{1,120}$/.test(v)
const isRewindMode = (v: unknown): v is RewindMode => v === "files" || v === "chat" || v === "both" || v === "summarize"
const isApprovalMode = (v: unknown): v is ApprovalMode => v === "auto" || v === "ask"

export function uxStatus() {
  const f = loadFlags([Global.Path.config])
  return {
    rewind: f.rewind.enabled,
    rewindMax: f.rewind.max,
    planApproval: f.planApproval.enabled,
    subagents: f.subagents.enabled,
    handoff: f.handoff.enabled,
  }
}

export const ezkUxRoutes = <A, E, R>(authLayer: Layer.Layer<A, E, R>) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const sessions = yield* Session.Service
      // request handlers of a raw router do not see the app services: hand them the ones this layer was built with
      const services = yield* Effect.context<never>()

      /** Run `effect` inside the project instance of `sessionID`; failures become JSON errors. */
      const inSession = <T, Err, Req>(sessionID: string, effect: Effect.Effect<T, Err, Req>) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(SessionID.make(sessionID))
          const ctx = yield* store.load({ directory: session.directory })
          return json(yield* effect.pipe(Effect.provideService(InstanceRef, ctx), Effect.provide(services)) as Effect.Effect<T, Err>)
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause) as { _tag?: string; message?: string }
            const status = error?._tag === "SessionBusyError" ? 409 : error?._tag === "NotFoundError" || /not found/i.test(error?.message ?? "") ? 404 : 500
            return Effect.succeed(json({ error: status === 409 ? "session is busy" : (error?.message ?? "failed") }, status))
          }),
        )

      yield* router.add("GET", "/ezk/ux/status", () => Effect.succeed(json(uxStatus())))

      yield* router.add("GET", "/ezk/ux/checkpoints", (request) => {
        const sessionID = query(request.url, "sessionID")
        if (!uxStatus().rewind) return Effect.succeed(json({ error: "rewind is off" }, 404))
        if (!validSession(sessionID)) return Effect.succeed(json({ error: "sessionID required" }, 400))
        return inSession(sessionID, Effect.gen(function* () {
          const [{ checkpoints }, { formatBytes }] = yield* Effect.promise(() => Promise.all([
            import("@/ezk/rewind"),
            import("@opencode-ai/core/ezk/ux/checkpoints"),
          ]))
          return yield* checkpoints(SessionID.make(sessionID)).pipe(Effect.map((r) => ({ ...r, diskText: formatBytes(r.diskBytes) })))
        }))
      })

      yield* router.add("POST", "/ezk/ux/rewind", (request) =>
        Effect.gen(function* () {
          const b = yield* body(request)
          if (!uxStatus().rewind) return json({ error: "rewind is off" }, 404)
          if (!validSession(b.sessionID) || typeof b.messageID !== "string" || !b.messageID.startsWith("msg") || !isRewindMode(b.mode))
            return json({ error: "sessionID, messageID and mode (files|chat|both|summarize) required" }, 400)
          return yield* inSession(b.sessionID, Effect.gen(function* () {
            const { rewind } = yield* Effect.promise(() => import("@/ezk/rewind"))
            return yield* rewind({ sessionID: SessionID.make(b.sessionID), messageID: MessageID.make(b.messageID), mode: b.mode, lang: lang(b.lang) })
          }))
        }),
      )

      yield* router.add("POST", "/ezk/ux/rewind/undo", (request) =>
        Effect.gen(function* () {
          const b = yield* body(request)
          if (!uxStatus().rewind) return json({ error: "rewind is off" }, 404)
          if (!validSession(b.sessionID) || typeof b.snapshot !== "string" || !/^[0-9a-f]{40,64}$/.test(b.snapshot))
            return json({ error: "sessionID and snapshot required" }, 400)
          return yield* inSession(b.sessionID, Effect.gen(function* () {
            const { undoFiles } = yield* Effect.promise(() => import("@/ezk/rewind"))
            return yield* undoFiles({ sessionID: SessionID.make(b.sessionID), snapshot: b.snapshot }).pipe(Effect.as({ ok: true }))
          }))
        }),
      )

      yield* router.add("GET", "/ezk/ux/plan", (request) => {
        const sessionID = query(request.url, "sessionID")
        if (!validSession(sessionID)) return Effect.succeed(json({ error: "sessionID required" }, 400))
        return Effect.promise(async () => {
          const { planStore } = await import("@/ezk/plan")
          const approved = planStore().get(sessionID)
          return json({
            enabled: uxStatus().planApproval,
            approved: approved ? { mode: approved.mode, at: approved.at, messageID: approved.messageID, plan: approved.plan } : undefined,
          })
        })
      })

      yield* router.add("POST", "/ezk/ux/plan/approve", (request) =>
        Effect.gen(function* () {
          const b = yield* body(request)
          if (!uxStatus().planApproval) return json({ error: "plan approval is off" }, 404)
          if (!validSession(b.sessionID) || !isApprovalMode(b.mode)) return json({ error: "sessionID and mode (auto|ask) required" }, 400)
          if (b.text !== undefined && (typeof b.text !== "string" || b.text.length > 100_000)) return json({ error: "bad plan text" }, 400)
          return yield* inSession(b.sessionID, Effect.gen(function* () {
            const { approve } = yield* Effect.promise(() => import("@/ezk/plan"))
            return yield* approve({ sessionID: SessionID.make(b.sessionID), mode: b.mode, text: b.text, lang: lang(b.lang) })
          }))
        }),
      )

      yield* router.add("POST", "/ezk/ux/handoff", (request) =>
        Effect.gen(function* () {
          const b = yield* body(request)
          if (!uxStatus().handoff) return json({ error: "handoff is off" }, 404)
          if (!validSession(b.sessionID) || typeof b.goal !== "string" || !b.goal.trim() || b.goal.length > 2_000)
            return json({ error: "sessionID and goal required" }, 400)
          return yield* inSession(b.sessionID, Effect.gen(function* () {
            const { handoff } = yield* Effect.promise(() => import("@/ezk/handoff"))
            return yield* handoff({ sessionID: SessionID.make(b.sessionID), goal: b.goal })
          }))
        }),
      )
    }),
  ).pipe(Layer.provide(authLayer))
