import { detectLang } from "@opencode-ai/core/ezkielyna-errors"

const en = {
  title: "Ezkielyna Agent Beta: version {version}",
  "try.fix": "Ask the agent to fix a bug in your project",
  "try.tests": "Run tests",
  "try.auto": "Let Auto choose a model",
  hint: "Type /lapor to report a problem",
} as const

const id: Record<keyof typeof en, string> = {
  title: "Ezkielyna Agent Beta: versi {version}",
  "try.fix": "Minta agen membetulkan bug di proyek Anda",
  "try.tests": "Jalankan test",
  "try.auto": "Biarkan Auto memilih model",
  hint: "Ketik /lapor untuk melaporkan masalah",
}

export type BetaStringKey = keyof typeof en

export function betaT(lang = detectLang()) {
  const table = lang === "id" ? id : en
  return (key: BetaStringKey) => table[key] ?? en[key]
}
