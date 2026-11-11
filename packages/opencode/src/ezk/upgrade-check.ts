// P6: `ezkielyna upgrade <version>` must say why it refuses a bad or older version and exit non-zero, instead of printing "Done".
// Pure decision over (requested, installed, latest signed); the command prints the reason.
import semver from "semver"
import { detectLang, type Lang } from "@opencode-ai/core/ezkielyna-errors"

export type UpgradeCheck =
  | { ok: true; target: string; same: boolean }
  | { ok: false; kind: "invalid" | "older" | "not-current"; reason: string }

export function checkUpgradeTarget(input: {
  /** what the user typed after `upgrade`, or undefined for "the latest" */
  requested?: string
  current: string
  /** the newest signed release, or undefined when it could not be checked */
  latest?: string
  /** is an update server configured at all? Without one the install step explains that itself. */
  hasServer?: boolean
  lang?: Lang
}): UpgradeCheck {
  const lang = input.lang ?? detectLang()
  const target = (input.requested ?? input.latest ?? input.current).trim().replace(/^v/i, "")
  const text = {
    en: {
      invalid: `"${input.requested}" is not a version number. Use one like ${semver.valid(input.current) ? input.current : "1.19.3-ezk.7"}, or leave it out to get the latest.`,
      older: `${target} is older than the installed ${input.current}. upgrade only moves forward.`,
      notCurrent: `${target} is not the current signed release${input.latest ? ` (the latest is ${input.latest})` : ""}. Only the current signed release can be installed: run ezkielyna upgrade.`,
    },
    id: {
      invalid: `"${input.requested}" bukan nomor versi. Pakai yang seperti ${semver.valid(input.current) ? input.current : "1.19.3-ezk.7"}, atau kosongkan untuk versi terbaru.`,
      older: `${target} lebih lama dari versi terpasang ${input.current}. upgrade hanya maju ke versi lebih baru.`,
      notCurrent: `${target} bukan rilis bertanda tangan yang terbaru${input.latest ? ` (yang terbaru ${input.latest})` : ""}. Hanya rilis terbaru yang bisa dipasang: jalankan ezkielyna upgrade.`,
    },
  }[lang]
  if (input.requested !== undefined && !semver.valid(target)) return { ok: false, kind: "invalid", reason: text.invalid }
  if (semver.valid(target) && semver.valid(input.current) && semver.lt(target, input.current)) return { ok: false, kind: "older", reason: text.older }
  if (input.requested !== undefined && input.hasServer !== false && input.latest && target !== input.current && target !== input.latest) {
    return { ok: false, kind: "not-current", reason: text.notCurrent }
  }
  return { ok: true, target, same: target === input.current }
}
