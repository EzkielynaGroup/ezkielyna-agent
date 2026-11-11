import type { Check } from "./doctor"
import { inferKeyGroup, type KeyGroupId, type KeyGroupModel } from "../key-group"

export type BetaHealthCheck = Pick<Check, "id" | "status" | "label" | "detail">
export type BetaHealthLanguage = "en" | "id"

const GROUP_LABEL: Record<BetaHealthLanguage, Record<KeyGroupId, string>> = {
  en: { hemat: "Budget", standard: "Standard", premium: "Premium", auto: "Auto", flash: "Flash" },
  id: { hemat: "Hemat", standard: "Standard", premium: "Premium", auto: "Auto", flash: "Flash" },
}

const TEXT = {
  en: {
    group: "Key group",
    missingKey: "Add an API key to check which models are available.",
    unreachable: "Key group is unknown until the model gateway is reachable.",
    unknown: "Could not identify a key group from the available models.",
    groupSummary: (name: string, count: number) => `${name} key group · ${count} models (estimated).`,
    hemat: (count: number) => `Budget key group: only ${count} models. Use the Auto key group for all available models.`,
  },
  id: {
    group: "Grup key",
    missingKey: "Tambahkan kunci API untuk memeriksa model yang tersedia.",
    unreachable: "Grup key belum diketahui sampai gateway model bisa dihubungi.",
    unknown: "Grup key tidak bisa dipastikan dari model yang tersedia.",
    groupSummary: (name: string, count: number) => `Grup key ${name} · ${count} model (perkiraan).`,
    hemat: (count: number) => `Grup key Hemat hanya ${count} model. Pakai key grup Auto untuk semua model yang tersedia.`,
  },
} satisfies Record<BetaHealthLanguage, Record<string, unknown>>

export function isBetaBuild(version: string) {
  return version.includes("-ezk.")
}

export function shouldShowBetaWelcome(version: string, dismissedVersion: string | undefined) {
  return isBetaBuild(version) && dismissedVersion !== version
}

export function shouldRunBetaHealthCheck(version: string, checkedVersion: string | undefined) {
  return isBetaBuild(version) && checkedVersion !== version
}

/** Selects only the first-run checks that help a tester get started, using doctor wording for fixes. */
export function mapBetaHealth(checks: readonly Check[], models: readonly KeyGroupModel[], lang: BetaHealthLanguage): BetaHealthCheck[] {
  const byID = new Map(checks.map((check) => [check.id, check]))
  const visible = ["key", "gateway", "disk", "trust"].flatMap((id) => {
    const check = byID.get(id)
    return check ? [{ id: check.id, status: check.status, label: check.label, detail: check.detail }] : []
  })
  const key = byID.get("key")
  const gateway = byID.get("gateway")
  const summary = key?.status === "ok" && gateway?.status === "ok" ? inferKeyGroup(models) : undefined
  const group = !key || !gateway ? undefined : {
    id: "group",
    status: summary ? (summary.id === "hemat" ? "warn" : "ok") : "warn",
    label: TEXT[lang].group,
    detail: key.status !== "ok" ? TEXT[lang].missingKey : gateway.status !== "ok" ? TEXT[lang].unreachable :
      summary?.id === "hemat" ? TEXT[lang].hemat(summary.modelCount) :
      summary ? TEXT[lang].groupSummary(GROUP_LABEL[lang][summary.id], summary.modelCount) : TEXT[lang].unknown,
  } satisfies BetaHealthCheck
  const groupIndex = visible.findIndex((check) => check.id === "gateway")
  if (group) visible.splice(groupIndex < 0 ? visible.length : groupIndex + 1, 0, group)
  return visible
}
