import fs from "node:fs"
import path from "node:path"
import { mapBetaHealth } from "@opencode-ai/core/ezk/diag/beta-welcome"
import { runDoctor, type DoctorDeps } from "@opencode-ai/core/ezk/diag/doctor"
import { DEFAULT_POLICY } from "@opencode-ai/core/ezk/model-policy"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const json = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status })
const language = (url: string) => (new URL(url, "http://local").searchParams.get("lang") === "id" ? ("id" as const) : ("en" as const))

function requestDirectory(url: string) {
  const directory = new URL(url, "http://local").searchParams.get("directory")
  if (!directory || !path.isAbsolute(directory)) return
  try {
    if (fs.statSync(directory).isDirectory()) return directory
  } catch {}
}

/** Read-only first-run checklist. `doctorDeps.models` shares the provider's in-flight /v1/models request. */
export const ezkBetaWelcomeRoutes = <A, E, R>(authLayer: Layer.Layer<A, E, R>) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add("GET", "/ezk/beta/health", (request: HttpServerRequest.HttpServerRequest) =>
        Effect.promise(async () => {
          if (!InstallationVersion.includes("-ezk.")) return json({ error: "not available" }, 404)
          const directory = requestDirectory(request.url)
          if (!directory) return json({ error: "an existing absolute directory is required" }, 400)
          const { doctorDeps } = await import("@/ezk/doctor-cli")
          const deps = doctorDeps(directory)
          let available: Awaited<ReturnType<DoctorDeps["models"]>> | undefined
          const checks = await runDoctor(
            { ...deps, models: async () => (available = await deps.models()) },
            language(request.url),
          )
          const models = (available?.ok ? available.ids : []).map((id) => ({
            id,
            groups: DEFAULT_POLICY.models[id]?.groups,
            groupRatio: DEFAULT_POLICY.models[id]?.groupRatio ?? DEFAULT_POLICY.groupRatio,
          }))
          return json({ checks: mapBetaHealth(checks, models, language(request.url)) })
        }),
      )
    }),
  ).pipe(Layer.provide(authLayer))
