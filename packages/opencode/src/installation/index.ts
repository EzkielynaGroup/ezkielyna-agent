import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { assertSecureBase, fetchVerifiedManifest, verifySignature } from "@opencode-ai/core/ezkielyna-update"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"

// Ezkielyna Agent: the only install method is our own signed installer (site/install.sh, install.ps1) or the desktop
// app. The upstream npm/brew/choco/scoop/bun upgrade paths and the OpenCode 2 offer were removed on purpose: they
// would replace this app with the upstream product.
export type Method = "curl" | "unknown"

export const Event = InstallationEvent

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `ezkielyna-agent/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

/** A release counts as an update only when it is strictly newer (the signed manifest check enforces the same rule). */
export function isUpdate(current: string, latest: string) {
  if (!semver.valid(latest)) return false
  if (!semver.valid(current)) return true
  return semver.gt(latest, current)
}

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const upgradeFailure = () => "Upgrade failed. Run the installer again: curl -fsSL " + EZK.storeURL + "/agent/install.sh | sh"

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        // Ezkielyna Agent: the installer script is fetched over HTTPS and must carry a valid offline signature
        // (install.sh.sig); the manifest for `target` is verified again so a stale or forged version is refused.
        const base = assertSecureBase(EZK.updateURL)
        const verified = yield* Effect.tryPromise(() => fetchVerifiedManifest({ base, currentVersion: InstallationVersion }))
        if (verified.manifest.version !== target) return yield* Effect.fail(new Error("target is not the verified latest version"))
        const response = yield* httpOk.execute(HttpClientRequest.get(`${base}/install.sh`))
        const bodyBytes = new Uint8Array(yield* response.arrayBuffer)
        const sigResponse = yield* httpOk.execute(HttpClientRequest.get(`${base}/install.sh.sig`))
        const signature = new Uint8Array(yield* sigResponse.arrayBuffer)
        if (!verifySignature(bodyBytes, signature)) return yield* Effect.fail(new Error("install.sh signature does not verify"))
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target, EZK_BASE_URL: base },
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure() })),
    )

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        return "curl" as Method
      }),
      // No update server configured means no network call at all. Otherwise only a signed, strictly newer manifest
      // counts (core/src/ezkielyna-update.ts); anything else reports the installed version.
      latest: Effect.fn("Installation.latest")(function* (_installMethod?: Method) {
        if (!EZK.updateURL) return InstallationVersion
        return yield* Effect.tryPromise({
          try: () => fetchVerifiedManifest({ base: EZK.updateURL, currentVersion: InstallationVersion }),
          catch: (cause) => cause,
        }).pipe(
          Effect.map((verified) => verified.manifest.version),
          Effect.catch(() => Effect.succeed(InstallationVersion)),
          Effect.timeout("10 seconds"),
        )
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (_installMethod: Method, target: string) {
        if (!EZK.updateURL)
          return yield* new UpgradeFailedError({
            stderr: "No update server is configured (set EZK_UPDATE_URL). Download the latest build from " + EZK.storeURL,
          })
        const upgradeResult = yield* upgradeCurl(target)
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure() })
        }
        yield* Effect.logInfo("upgraded", { target, stdout: upgradeResult.stdout, stderr: upgradeResult.stderr })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
