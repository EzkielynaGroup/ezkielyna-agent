import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadFlags, type EzkFlags } from "@opencode-ai/core/ezk/flags"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import { type DoctorDeps, runDoctor } from "@opencode-ai/core/ezk/diag/doctor"
import { renderBugReport, type ReportLanguage } from "@opencode-ai/core/ezk/diag/report"
import { DEFAULT_POLICY, loadPolicy, type ModelPolicy } from "@opencode-ai/core/ezk/model-policy"
import { Global } from "@opencode-ai/core/global"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { stripJsonc } from "@opencode-ai/core/ezk/flags"
import { doctorDeps } from "./doctor-cli"

export type BugReportDeps = {
  doctor: DoctorDeps
  flags: EzkFlags
  enabledFlags?: readonly string[]
  language: ReportLanguage
  version: string
  channel: string
  os: string
  arch: string
  locale: string
  homeDir: string
  /** Other spellings of the home folder (USERPROFILE, HOME) and the account name; all redacted from the report. */
  homeDirs?: readonly string[]
  userName?: string
  freeRamBytes: number
  model?: string
  readLogs: () => string[]
  policy: () => Promise<ModelPolicy>
  now: () => Date
}

export async function buildBugReport(deps: BugReportDeps) {
  const key = deps.doctor.key()
  let available: { ok: boolean; status?: number; ms: number; ids: string[]; error?: string } | undefined
  const checks = await runDoctor(
    {
      ...deps.doctor,
      key: () => key,
      models: async () => (available = await deps.doctor.models()),
    },
    deps.language,
  )
  const policy = await deps.policy().catch(() => DEFAULT_POLICY)
  const models = (available?.ids ?? []).map((id) => ({
    id,
    groups: policy.models[id]?.groups,
    groupRatio: policy.models[id]?.groupRatio ?? policy.groupRatio,
  }))
  const logs = deps.readLogs().filter((line) => /\blevel=(?:Warn|Error)\b/i.test(line)).slice(-50)
  const lastFailure = [...logs].reverse().find((line) => /\b(?:failed|error|request|status|http)\b/i.test(line))
  const status = lastFailure?.match(/\b(?:status|http)[=: ]+(\d{3})\b/i)?.[1]
  const failedRequest = available && !available.ok
    ? { status: available.status, error: available.error ?? (available.status ? `HTTP ${available.status}` : "model check failed") }
    : lastFailure
      ? { status: status ? Number(status) : undefined, error: lastFailure }
      : undefined

  return renderBugReport({
    language: deps.language,
    generatedAt: deps.now().toISOString(),
    version: deps.version,
    channel: deps.channel,
    os: deps.os,
    arch: deps.arch,
    locale: deps.locale,
    checks,
    features: deps.doctor.features,
    enabledFlags: enabledFlagNames(deps.flags, deps.enabledFlags),
    model: deps.model ?? readConfiguredModel(Global.Path.config),
    models,
    keyPresent: key.present,
    logLines: logs,
    lastFailedRequest: failedRequest,
    freeDiskBytes: deps.doctor.diskFreeBytes(),
    freeRamBytes: deps.freeRamBytes,
    homeDir: deps.homeDir,
    homeDirs: deps.homeDirs,
    userName: deps.userName,
  })
}

export function enabledFlagNames(flags: EzkFlags, additional: readonly string[] = []) {
  const result: string[] = []
  const visit = (value: unknown, prefix: string) => {
    if (!value || typeof value !== "object") return
    for (const [name, item] of Object.entries(value)) {
      const key = prefix ? `${prefix}.${name}` : name
      if (typeof item === "boolean") {
        if (item) result.push(key)
      } else if (item && typeof item === "object") visit(item, key)
    }
  }
  visit(flags, "")
  return [...new Set([...result, ...additional])].sort()
}

export function readConfiguredModel(configDir: string) {
  for (const file of ["ezkielyna.jsonc", "ezkielyna.json", "config.json"]) {
    try {
      const value = JSON.parse(stripJsonc(fs.readFileSync(path.join(configDir, file), "utf8"))) as { model?: unknown }
      if (typeof value.model === "string" && value.model.trim()) return value.model.trim()
    } catch {}
  }
}

/** Older installs logged to opencode.log: read it first (oldest lines), then the current ezkielyna.log. */
export function readRecentReportLogs(
  files: string | string[] = [path.join(Global.Path.log, EZK.legacyLogFile), path.join(Global.Path.log, EZK.logFile)],
) {
  return (Array.isArray(files) ? files : [files]).flatMap(tailWarnLines).slice(-50)
}

/** Read only a bounded tail of one log file; a report never scans or copies an unbounded log. */
function tailWarnLines(file: string) {
  try {
    const fd = fs.openSync(file, "r")
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, 256 * 1024)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      return buffer
        .toString("utf8")
        .split(/\r?\n/)
        .filter((line) => /\blevel=(?:Warn|Error)\b/i.test(line))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
}

function accountName() {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME ?? process.env.USER
  }
}

export function reportDependencies(language: ReportLanguage, cwd = process.cwd(), model?: string): BugReportDeps {
  const doctor = doctorDeps(cwd)
  return {
    doctor,
    flags: loadFlags([Global.Path.config]),
    enabledFlags: (["exec", "exec-cli", "diagnostics", "statusline"] as const).filter((name) => execEnabled(name)),
    language,
    version: InstallationVersion,
    channel: InstallationChannel,
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale || "unknown",
    homeDir: os.homedir(),
    homeDirs: [process.env.USERPROFILE, process.env.HOME, `${process.env.HOMEDRIVE ?? ""}${process.env.HOMEPATH ?? ""}`].filter((value): value is string => Boolean(value)),
    userName: accountName(),
    freeRamBytes: os.freemem(),
    model,
    readLogs: readRecentReportLogs,
    policy: () => loadPolicy({ configDir: Global.Path.config, cacheDir: Global.Path.cache }),
    now: () => new Date(),
  }
}
