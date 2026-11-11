// Ezkielyna Agent Wave B: /ezk/permission, /ezk/trust and /ezk/hooks JSON routes for the TUI and the desktop.
// Every route takes the project folder as `directory` (query or body), like the other /ezk routes.
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type { HttpRouter } from "effect/unstable/http"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { forgetTrustedEntry, isProjectTrusted, trustProject, untrustProject } from "@opencode-ai/core/ezkielyna-trust"
import { Global } from "@opencode-ai/core/global"
import { loadFlags } from "@opencode-ai/core/ezk/flags"
import { trustFile } from "@/config/trust"

const json = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status })
const query = (url: string, name: string) => new URL(url, "http://local").searchParams.get(name) ?? undefined
const body = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(Effect.map((v) => (v && typeof v === "object" ? (v as Record<string, any>) : {})), Effect.orElseSucceed(() => ({}) as Record<string, any>))

/** The git worktree that contains `directory`, if any (the trust and rule files live at the project root). */
function worktreeOf(directory: string) {
  for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    if (path.dirname(dir) === dir) return undefined
  }
}

function projectRoot(directory: string, worktree?: string) {
  return worktree && worktree !== "/" ? worktree : directory
}

function folder(value: unknown) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value) || !fs.existsSync(value)) return
  return value
}

export async function permissionStatus(directory: string, sessionID?: string) {
  const [modesModule, rulesModule, safety] = await Promise.all([
    import("@opencode-ai/core/ezk/safety/modes"),
    import("@opencode-ai/core/ezk/safety/rules"),
    import("@/ezk/safety"),
  ])
  const worktree = worktreeOf(directory)
  const root = safety.projectRoot(directory, worktree)
  const mode = safety.currentMode(sessionID ?? "", directory, worktree)
  const f = safety.flags()
  return {
    flags: { modes: f.modes.enabled, rules: f.rules.enabled, hooks: f.hooks.enabled, trustUI: f.trust.ui },
    root,
    mode,
    modes: modesModule.MODES.map((id) => ({ id, label: modesModule.MODE_LABEL[id], hint: modesModule.MODE_HINT[id] })),
    notice: !mode.trusted && mode.requested !== "ask" && mode.requested !== "plan" ? modesModule.UNTRUSTED_NOTICE : mode.effective === "full" ? modesModule.FULL_WARNING : undefined,
    rules: rulesModule.loadRules({ root, userConfig: Global.Path.config, trusted: mode.trusted }).map((r) => ({ action: r.action, rule: r.raw, source: r.source, local: r.source === path.join(root, ".ezkielyna", "settings.local.json") })),
    denied: safety.recentlyDenied(),
  }
}

export function trustStatus(directory: string) {
  const worktree = worktreeOf(directory)
  const root = projectRoot(directory, worktree)
  const list = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(trustFile(), "utf8"))
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
    } catch {
      return []
    }
  })()
  return {
    enabled: loadFlags([Global.Path.config]).trust.ui,
    root,
    trusted: isProjectTrusted(root, { file: trustFile() }),
    list,
    banner: {
      en: "This folder is not trusted yet: project instructions and hooks are ignored.",
      id: "Folder ini belum dipercaya: instruksi dan hooks proyek diabaikan",
    },
  }
}

/** "Always allow in this project": one rule per `always` pattern of the request, saved to .ezkielyna/settings.local.json. */
function rulesForRequest(permission: string, patterns: string[], rulesModule: typeof import("@opencode-ai/core/ezk/safety/rules")) {
  if (permission === "bash") return patterns.filter((p) => typeof p === "string" && p.trim() && !rulesModule.riskyPrefix(p)).map((p) => rulesModule.formatBashRule(p.trim()))
  // never the bare `Edit` (it would also cover paths outside the project); protected paths still ask (see decide.ts)
  if (permission === "edit") return ["Edit(**)"]
  if (permission === "webfetch")
    return [...new Set(patterns.flatMap((p) => {
      try {
        return [`WebFetch(domain:${new URL(p).hostname})`]
      } catch {
        return []
      }
    }))]
  return []
}

export const ezkSafetyRoutes = (router: HttpRouter.HttpRouter) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/ezk/permission", (request) => {
      const directory = folder(query(request.url, "directory"))
      if (!directory) return Effect.succeed(json({ error: "directory required" }, 400))
      return Effect.promise(() => permissionStatus(directory, query(request.url, "sessionID"))).pipe(Effect.map(json))
    })

    yield* router.add("POST", "/ezk/permission/mode", (request) =>
      Effect.gen(function* () {
        const b = yield* body(request)
        const directory = folder(b.directory)
        const { parseMode } = yield* Effect.promise(() => import("@opencode-ai/core/ezk/safety/modes"))
        const mode = parseMode(b.mode)
        if (!directory || !mode) return json({ error: "directory and a valid mode required" }, 400)
        const sessionID = typeof b.sessionID === "string" && b.sessionID ? b.sessionID : undefined
        const { setMode } = yield* Effect.promise(() => import("@/ezk/safety"))
        setMode(sessionID, mode)
        return json(yield* Effect.promise(() => permissionStatus(directory, sessionID)))
      }),
    )

    yield* router.add("POST", "/ezk/permission/remember", (request) =>
      Effect.gen(function* () {
        const b = yield* body(request)
        const directory = folder(b.directory)
        if (!directory || typeof b.permission !== "string" || !Array.isArray(b.patterns)) return json({ error: "directory, permission and patterns required" }, 400)
        const [{ projectRoot, invalidateRules }, modesModule, rulesModule] = yield* Effect.promise(() => Promise.all([
          import("@/ezk/safety"),
          import("@opencode-ai/core/ezk/safety/modes"),
          import("@opencode-ai/core/ezk/safety/rules"),
        ]))
        const root = projectRoot(directory, worktreeOf(directory))
        // remembered allow rules are ignored in untrusted folders, so do not pretend to save one there
        if (!isProjectTrusted(root, { file: trustFile() })) return json({ error: "folder not trusted", notice: modesModule.UNTRUSTED_NOTICE }, 409)
        const rules = rulesForRequest(b.permission, b.patterns, rulesModule)
        const skipped = b.permission === "bash" ? b.patterns.filter((p: unknown) => typeof p === "string" && rulesModule.riskyPrefix(p)) : []
        if (!rules.length) return json({ error: "nothing safe to remember for this request", skipped }, 422)
        const file = rules.map((rule) => rulesModule.rememberRule(root, rule)).at(-1)
        invalidateRules()
        return json({ saved: rules, skipped, file })
      }),
    )

    yield* router.add("POST", "/ezk/permission/forget", (request) =>
      Effect.gen(function* () {
        const b = yield* body(request)
        const directory = folder(b.directory)
        if (!directory || typeof b.rule !== "string") return json({ error: "directory and rule required" }, 400)
        const [{ projectRoot, invalidateRules }, { forgetRule }] = yield* Effect.promise(() => Promise.all([
          import("@/ezk/safety"),
          import("@opencode-ai/core/ezk/safety/rules"),
        ]))
        const removed = forgetRule(projectRoot(directory, worktreeOf(directory)), b.rule)
        invalidateRules()
        return json({ removed })
      }),
    )

    yield* router.add("GET", "/ezk/trust", (request) => {
      const directory = folder(query(request.url, "directory"))
      if (!directory) return Effect.succeed(json({ error: "directory required" }, 400))
      return Effect.succeed(json(trustStatus(directory)))
    })

    yield* router.add("POST", "/ezk/trust", (request) =>
      Effect.gen(function* () {
        const b = yield* body(request)
        const directory = folder(b.directory)
        if (!directory) return json({ error: "directory required" }, 400)
        trustProject(projectRoot(directory, worktreeOf(directory)), { file: trustFile() })
        ;(yield* Effect.promise(() => import("@/ezk/safety"))).invalidateRules()
        return json(trustStatus(directory))
      }),
    )

    // remove a folder from the trusted list (settings list "remove", or "Keep untrusted" after a mistake)
    yield* router.add("POST", "/ezk/trust/remove", (request) =>
      Effect.gen(function* () {
        const b = yield* body(request)
        if (typeof b.path !== "string" || !b.path) return json({ error: "path required" }, 400)
        // a folder that no longer exists can still be removed from the list by its exact entry
        const removed = fs.existsSync(b.path) ? untrustProject(b.path, { file: trustFile() }) : forgetTrustedEntry(b.path, { file: trustFile() })
        ;(yield* Effect.promise(() => import("@/ezk/safety"))).invalidateRules()
        return json({ removed, list: trustStatus(folder(b.directory) ?? Global.Path.home).list })
      }),
    )

    yield* router.add("GET", "/ezk/hooks", (request) => {
      const directory = folder(query(request.url, "directory"))
      if (!directory) return Effect.succeed(json({ error: "directory required" }, 400))
      return Effect.promise(async () => json((await import("@/plugin/ezk/safety")).hooksStatus(directory, worktreeOf(directory))))
    })

    yield* router.add("POST", "/ezk/hooks/ack", (request) =>
      Effect.gen(function* () {
        const b = yield* body(request)
        const directory = folder(b.directory)
        if (!directory || typeof b.fingerprint !== "string") return json({ error: "directory and fingerprint required" }, 400)
        ;(yield* Effect.promise(() => import("@/plugin/ezk/safety"))).acknowledgeHooks(directory, worktreeOf(directory), b.fingerprint)
        return json({ ok: true })
      }),
    )
  })
