import { inferKeyGroup, type KeyGroupModel } from "../key-group"
import type { Check } from "./doctor"
import { capLine, redactText, sanitizeLogLine, type RedactOptions } from "./redact"

export { LOG_LINE_LIMIT, redactText, sanitizeLogLine } from "./redact"

export type ReportLanguage = "en" | "id"

export type BugReportInput = {
  language: ReportLanguage
  generatedAt: string
  version: string
  channel: string
  os: string
  arch: string
  locale: string
  checks: readonly Check[]
  features?: string
  enabledFlags: readonly string[]
  model?: string
  models: readonly KeyGroupModel[]
  keyPresent: boolean
  logLines: readonly string[]
  lastFailedRequest?: { status?: number; error?: string }
  freeDiskBytes?: number
  freeRamBytes?: number
  homeDir?: string
  /** More spellings of the home folder (USERPROFILE, HOME). */
  homeDirs?: readonly string[]
  /** Account name; replaced as a whole word. */
  userName?: string
}

const labels = {
  en: {
    title: "Ezkielyna Agent bug report",
    generated: "Generated",
    app: "App",
    system: "System",
    locale: "Locale",
    checks: "Doctor checks",
    features: "EZK_FEATURES",
    enabledFlags: "Enabled flags",
    model: "Current model",
    keyGroup: "Key group (estimated)",
    key: "API key",
    present: "present",
    missing: "missing",
    logs: "Recent warnings and errors (up to 50)",
    noLogs: "No warning or error log lines found.",
    failedRequest: "Last failed request",
    noFailedRequest: "No failed request recorded.",
    disk: "Free disk",
    ram: "Free RAM",
    unknown: "unknown",
    bytes: (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`,
  },
  id: {
    title: "Laporan masalah Ezkielyna Agent",
    generated: "Dibuat",
    app: "Aplikasi",
    system: "Sistem",
    locale: "Bahasa sistem",
    checks: "Pemeriksaan doctor",
    features: "EZK_FEATURES",
    enabledFlags: "Fitur aktif",
    model: "Model yang digunakan",
    keyGroup: "Grup kunci (perkiraan)",
    key: "Kunci API",
    present: "ada",
    missing: "tidak ada",
    logs: "Peringatan dan kesalahan terbaru (maks. 50)",
    noLogs: "Tidak ada baris log peringatan atau kesalahan.",
    failedRequest: "Permintaan gagal terakhir",
    noFailedRequest: "Tidak ada permintaan gagal yang tercatat.",
    disk: "Disk kosong",
    ram: "RAM kosong",
    unknown: "tidak diketahui",
    bytes: (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`,
  },
} satisfies Record<ReportLanguage, Record<string, string | ((n: number) => string)>>

/**
 * Redact arbitrary free-form text (strict: also the value of every key=value pair whose key looks sensitive). The report itself is
 * built from fixed labels plus untrusted fragments; see renderBugReport.
 */
export function redactBugReport(text: string, homeDir?: string, options: Omit<RedactOptions, "homeDir"> = {}) {
  return redactText(text, { strict: true, ...options, homeDir })
}

export function renderBugReport(input: BugReportInput) {
  const t = labels[input.language]
  const group = inferKeyGroup(input.models)
  const context = { homeDir: input.homeDir, homeDirs: input.homeDirs, userName: input.userName }
  // Fixed labels go through the light pass only ("API key: present" must stay readable); free-form fragments go through the strict one.
  const light = (value: string) => redactText(value, context)
  const strict = (value: string) => redactText(value, { ...context, strict: true })
  const logLine = (value: string) => capLine(strict(sanitizeLogLine(value)))
  const checkLines = input.checks.map((check) => light(`${check.status.toUpperCase()} ${check.label}: ${check.detail}`))
  const failed = input.lastFailedRequest
    ? [input.lastFailedRequest.status === undefined ? undefined : `HTTP ${input.lastFailedRequest.status}`, input.lastFailedRequest.error && logLine(input.lastFailedRequest.error)]
        .filter(Boolean)
        .join(" — ") || t.unknown
    : t.noFailedRequest
  const text = [
    t.title,
    `${t.generated}: ${input.generatedAt}`,
    `${t.app}: ${input.version} (${input.channel})`,
    `${t.system}: ${input.os} / ${input.arch}`,
    `${t.locale}: ${input.locale}`,
    "",
    t.checks,
    ...(checkLines.length ? checkLines : [t.unknown]),
    "",
    `${t.features}: ${input.features ? strict(input.features) : t.unknown}`,
    `${t.enabledFlags}: ${input.enabledFlags.length ? strict(input.enabledFlags.join(", ")) : t.unknown}`,
    `${t.model}: ${input.model ? strict(input.model) : t.unknown}`,
    `${t.keyGroup}: ${group?.id ?? t.unknown}${group?.ratio ? ` (${group.ratio}x)` : ""}`,
    `${t.key}: ${input.keyPresent ? t.present : t.missing}`,
    `${t.disk}: ${input.freeDiskBytes === undefined ? t.unknown : t.bytes(input.freeDiskBytes)}`,
    `${t.ram}: ${input.freeRamBytes === undefined ? t.unknown : t.bytes(input.freeRamBytes)}`,
    "",
    `${t.failedRequest}: ${failed}`,
    "",
    t.logs,
    ...(input.logLines.length ? input.logLines.slice(-50).map(logLine) : [t.noLogs]),
    "",
  ].join("\n")
  // Final pass over the whole text (light): version, locale, timestamps and anything the pieces above did not cover.
  return light(text)
}
