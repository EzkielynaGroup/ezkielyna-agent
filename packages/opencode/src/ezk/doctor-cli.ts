// U4 `ezkielyna doctor`: key present (never printed), connection, models, settings files in the order they are merged,
// folder trust, free disk space and the update channel. Read-only; exit code 1 only when a check fails.
import type { Argv } from "yargs"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { effectCmd, fail } from "@/cli/effect-cmd"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import { Global } from "@opencode-ai/core/global"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { listModels } from "@opencode-ai/core/ezkielyna"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { readGatewayKey } from "@opencode-ai/core/ezk/key"
import { localCredentialState } from "@opencode-ai/core/ezkielyna-localkey"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { type DoctorDeps, doctorExitCode, renderDoctor, runDoctor } from "@opencode-ai/core/ezk/diag/doctor"
import { projectTrusted } from "@/config/trust"
import { ConfigManaged } from "@/config/managed"

export const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "check the key, connection, models, settings, folder trust, disk space and updates",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("json", { type: "boolean", default: false, describe: "print the checks as JSON" }),
  handler: Effect.fn("Cli.doctor")(function* (args) {
    if (!execEnabled("diagnostics")) return yield* fail("`doctor` is turned off (EZK_FEATURES has -diagnostics).")
    const checks = yield* Effect.promise(() => runDoctor(doctorDeps(process.cwd()), detectLang()))
    process.stdout.write((args.json ? JSON.stringify(checks, null, 2) : renderDoctor(checks)) + "\n")
    process.exitCode = doctorExitCode(checks)
  }),
})

export function doctorDeps(cwd: string, env: Record<string, string | undefined> = process.env): DoctorDeps {
  const root = gitRoot(cwd)
  return {
    version: InstallationVersion,
    key: () => {
      const state = localCredentialState({ dataDir: Global.Path.data, env })
      if (state === "env") return { present: true, source: "env" }
      if (state === "keychain-unreadable") return { present: false, reason: "keychain-unreadable" }
      return state === "none" ? { present: false } : { present: true, source: "saved" }
    },
    models: async () => {
      const key = readGatewayKey(Global.Path.data, env)
      const result = await listModels({ key, cacheDir: Global.Path.cache, timeoutMs: 8_000, share: true })
      return { ok: result.reachable, status: result.status, ms: result.ms, ids: result.ids, error: result.error }
    },
    configSources: () => configSources({ cwd, root, env, trusted: projectTrusted(cwd, root) }),
    trust: () => ({ dir: root, trusted: projectTrusted(cwd, root) }),
    diskFreeBytes: () => {
      try {
        const stat = fs.statfsSync(fs.existsSync(Global.Path.data) ? Global.Path.data : cwd)
        return stat.bavail * stat.bsize
      } catch {
        return undefined
      }
    },
    dataDir: Global.Path.data,
    updateURL: EZK.updateURL,
    features: env.EZK_FEATURES?.trim() || undefined,
  }
}

/** The settings files the app merges, lowest priority first (mirrors config/config.ts and config/paths.ts). */
export function configSources(input: {
  cwd: string
  root: string
  env: Record<string, string | undefined>
  trusted: boolean
}) {
  const up = (name: string) => ancestors(input.cwd, input.root).map((dir) => path.join(dir, name))
  const list = [
    ...["config.json", "ezkielyna.json", "ezkielyna.jsonc"].map((f) => path.join(Global.Path.config, f)),
    ...(input.env.OPENCODE_CONFIG ? [input.env.OPENCODE_CONFIG] : []),
    ...(input.env.OPENCODE_DISABLE_PROJECT_CONFIG
      ? []
      : ancestors(input.cwd, input.root).flatMap((dir) => [
          path.join(dir, "ezkielyna.jsonc"),
          path.join(dir, "ezkielyna.json"),
        ])),
    ...(input.trusted && !input.env.OPENCODE_DISABLE_PROJECT_CONFIG
      ? up(".ezkielyna").flatMap((dir) => [path.join(dir, "ezkielyna.json"), path.join(dir, "ezkielyna.jsonc")])
      : []),
    ...(input.env.OPENCODE_CONFIG_DIR
      ? ["ezkielyna.json", "ezkielyna.jsonc"].map((f) => path.join(input.env.OPENCODE_CONFIG_DIR!, f))
      : []),
    ...["ezkielyna.json", "ezkielyna.jsonc"].map((f) => path.join(ConfigManaged.managedConfigDir(), f)),
  ]
  return [...new Set(list)].map((file) => ({ path: file, exists: fs.existsSync(file) }))
}

/** root first, ending at cwd */
function ancestors(cwd: string, root: string) {
  const out: string[] = []
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    out.unshift(dir)
    if (dir === root || path.dirname(dir) === dir) return out
  }
}

function gitRoot(cwd: string) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    if (path.dirname(dir) === dir) return path.resolve(cwd)
  }
}
