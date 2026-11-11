// U4 `ezkielyna doctor`: a health check in plain words. All I/O is injected, so the checks are unit-tested; the key is
// only ever reported as present or missing, never printed.
import { EZK } from "../../ezkielyna-brand"

export type CheckStatus = "ok" | "warn" | "fail"
export type Check = { id: string; status: CheckStatus; label: string; detail: string }
type Lang = "en" | "id"

export type DoctorDeps = {
  version: string
  key: () => { present: boolean; source?: "env" | "saved"; reason?: "keychain-unreadable" }
  models: () => Promise<{ ok: boolean; status?: number; ms: number; ids: string[]; error?: string }>
  /** config files lowest priority first, as the app merges them */
  configSources: () => { path: string; exists: boolean }[]
  trust: () => { dir: string; trusted: boolean }
  diskFreeBytes: () => number | undefined
  dataDir: string
  updateURL: string
  features?: string
}

const LOW_DISK = 1024 ** 3

const T = {
  en: {
    version: "Version",
    key: "API key",
    keyEnv: "found (from the EZKIELYNA_API_KEY environment variable)",
    keySaved: "found (saved on this computer)",
    keyMissing: `not found. Get one at ${EZK.keysURL}, then run \`ezkielyna auth login\` (or set EZKIELYNA_API_KEY).`,
    keyKeychainUnreadable:
      "saved in the system keychain, but it could not be read (keychain locked, access denied, or no keyring). Unlock the keychain or save the key again with `ezkielyna auth login`.",
    gateway: "Connection",
    gatewayOk: (ms: number) => `reachable (${ms} ms)`,
    gatewayAuth: "reachable, but the key was refused. Check that the key is correct and still active.",
    gatewayDown: (why: string) => `cannot be reached (${why}). Check your internet connection.`,
    gatewaySkip: "skipped (no API key)",
    models: "Models",
    modelsList: (n: number, list: string) => `${n} available: ${list}`,
    modelsNone: "none available for this key",
    config: "Settings files",
    configNone: "none yet (defaults are used)",
    configOrder: "applied in this order, later ones win:",
    trust: "This folder",
    trusted: (dir: string) => `trusted (${dir}): project settings, plugins and hooks are used`,
    untrusted: (dir: string) =>
      `not trusted (${dir}): project instructions and hooks are ignored. Run \`ezkielyna trust\` if you wrote it.`,
    disk: "Free disk space",
    diskLow: (gb: string) => `${gb} GB left. Under 1 GB, sessions and updates may fail.`,
    diskOk: (gb: string) => `${gb} GB`,
    diskUnknown: "unknown",
    update: "Updates",
    updateOn: (url: string) => `checked automatically (${new URL(url).host})`,
    updateOff: "automatic updates are off in this build. Download new versions from ezkielyna.store.",
    features: "Feature switches",
  },
  id: {
    version: "Versi",
    key: "Kunci API",
    keyEnv: "ada (dari variabel lingkungan EZKIELYNA_API_KEY)",
    keySaved: "ada (tersimpan di komputer ini)",
    keyMissing: `tidak ada. Dapatkan di ${EZK.keysURL}, lalu jalankan \`ezkielyna auth login\` (atau atur EZKIELYNA_API_KEY).`,
    keyKeychainUnreadable:
      "tersimpan di keychain sistem, tetapi tidak bisa dibaca (keychain terkunci, akses ditolak, atau tidak ada keyring). Buka kunci keychain atau simpan ulang kuncinya dengan `ezkielyna auth login`.",
    gateway: "Koneksi",
    gatewayOk: (ms: number) => `terhubung (${ms} ms)`,
    gatewayAuth: "terhubung, tetapi kunci ditolak. Pastikan kuncinya benar dan masih aktif.",
    gatewayDown: (why: string) => `tidak bisa dihubungi (${why}). Periksa koneksi internet Anda.`,
    gatewaySkip: "dilewati (belum ada kunci API)",
    models: "Model",
    modelsList: (n: number, list: string) => `${n} tersedia: ${list}`,
    modelsNone: "tidak ada yang tersedia untuk kunci ini",
    config: "File pengaturan",
    configNone: "belum ada (memakai pengaturan bawaan)",
    configOrder: "dipakai dengan urutan ini, yang belakangan menang:",
    trust: "Folder ini",
    trusted: (dir: string) => `dipercaya (${dir}): pengaturan, plugin, dan hooks proyek dipakai`,
    untrusted: (dir: string) =>
      `belum dipercaya (${dir}): instruksi dan hooks proyek diabaikan. Jalankan \`ezkielyna trust\` jika Anda yang membuatnya.`,
    disk: "Ruang disk kosong",
    diskLow: (gb: string) => `tersisa ${gb} GB. Di bawah 1 GB, sesi dan pembaruan bisa gagal.`,
    diskOk: (gb: string) => `${gb} GB`,
    diskUnknown: "tidak diketahui",
    update: "Pembaruan",
    updateOn: (url: string) => `diperiksa otomatis (${new URL(url).host})`,
    updateOff: "pembaruan otomatis mati di build ini. Unduh versi baru dari ezkielyna.store.",
    features: "Sakelar fitur",
  },
}

export async function runDoctor(deps: DoctorDeps, lang: Lang = "en"): Promise<Check[]> {
  const t = T[lang]
  const key = deps.key()
  const models = key.present ? await deps.models() : undefined
  const sources = deps.configSources()
  const found = sources.filter((s) => s.exists)
  const trust = deps.trust()
  const free = deps.diskFreeBytes()
  return [
    { id: "version", status: "ok", label: t.version, detail: deps.version },
    {
      id: "key",
      status: key.present ? "ok" : "fail",
      label: t.key,
      detail: key.present
        ? key.source === "env"
          ? t.keyEnv
          : t.keySaved
        : key.reason === "keychain-unreadable"
          ? t.keyKeychainUnreadable
          : t.keyMissing,
    },
    {
      id: "gateway",
      status: !models ? "warn" : models.ok ? "ok" : "fail",
      label: t.gateway,
      detail: !models
        ? t.gatewaySkip
        : models.ok
          ? t.gatewayOk(models.ms)
          : models.status === 401 || models.status === 403
            ? t.gatewayAuth
            : t.gatewayDown(models.error ?? `HTTP ${models.status}`),
    },
    ...(models?.ok
      ? [
          {
            id: "models",
            status: (models.ids.length ? "ok" : "warn") as CheckStatus,
            label: t.models,
            detail: models.ids.length ? t.modelsList(models.ids.length, models.ids.join(", ")) : t.modelsNone,
          },
        ]
      : []),
    {
      id: "config",
      status: "ok",
      label: t.config,
      detail: found.length
        ? `${t.configOrder}\n${found.map((s, i) => `  ${i + 1}. ${s.path}`).join("\n")}`
        : t.configNone,
    },
    {
      id: "trust",
      status: trust.trusted ? "ok" : "warn",
      label: t.trust,
      detail: trust.trusted ? t.trusted(trust.dir) : t.untrusted(trust.dir),
    },
    {
      id: "disk",
      status: free === undefined ? "warn" : free < LOW_DISK ? "warn" : "ok",
      label: t.disk,
      detail: free === undefined ? t.diskUnknown : free < LOW_DISK ? t.diskLow(gb(free)) : t.diskOk(gb(free)),
    },
    {
      id: "update",
      status: deps.updateURL ? "ok" : "warn",
      label: t.update,
      detail: deps.updateURL ? t.updateOn(deps.updateURL) : t.updateOff,
    },
    ...(deps.features
      ? [{ id: "features", status: "ok" as CheckStatus, label: t.features, detail: `EZK_FEATURES=${deps.features}` }]
      : []),
  ]
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" }

export function renderDoctor(checks: Check[]) {
  const width = Math.max(...checks.map((c) => c.label.length))
  return checks
    .map((c) => {
      const [first, ...rest] = c.detail.split("\n")
      return [
        `${MARK[c.status]} ${c.label.padEnd(width)}  ${first}`,
        ...rest.map((line) => `  ${" ".repeat(width)}  ${line}`),
      ].join("\n")
    })
    .join("\n")
}

/** 0 when nothing failed, 1 otherwise (warnings do not fail the check). */
export function doctorExitCode(checks: Check[]) {
  return checks.some((c) => c.status === "fail") ? 1 : 0
}

function gb(bytes: number) {
  return (bytes / 1024 ** 3).toFixed(1)
}
