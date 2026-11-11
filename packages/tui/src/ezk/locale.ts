// Ezkielyna Agent (C5): the first-run screens follow the system language like `doctor` and `account` do:
// LANG / LC_ALL = id_* (or EZK_LANG=id) gives Indonesian, anything else English. One table per surface, no supplier names.
import { detectLang, type Lang } from "@opencode-ai/core/ezkielyna-errors"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"

export const tuiLang = (): Lang => detectLang()

const HOME = {
  en: {
    normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
    shell: ["ls -la", "git status", "pwd"],
    ask: "Ask anything…",
    run: "Run a command…",
  },
  id: {
    normal: ["Perbaiki TODO di kode ini", "Apa tech stack proyek ini?", "Perbaiki tes yang gagal"],
    shell: ["ls -la", "git status", "pwd"],
    ask: "Tanyakan apa saja…",
    run: "Jalankan perintah…",
  },
} as const

export const homeStrings = (lang: Lang = tuiLang()) => HOME[lang]

const KEY_DIALOG = {
  en: {
    title: "Welcome to Ezkielyna Agent: enter your API key",
    placeholder: "API key",
    paste: "Paste your Ezkielyna API key (sk-...). It stays on this machine.",
    getKey: "Get a key:",
    plans: "Flash Plan and more:",
    invalid: (url: string) => `Ezkielyna API keys start with sk-. Get one at ${url}`,
  },
  id: {
    title: "Selamat datang di Ezkielyna Agent: masukkan kunci API Anda",
    placeholder: "Kunci API",
    paste: "Tempel kunci API Ezkielyna Anda (sk-...). Kunci hanya disimpan di komputer ini.",
    getKey: "Dapatkan kunci:",
    plans: "Flash Plan dan lainnya:",
    invalid: (url: string) => `Kunci API Ezkielyna diawali sk-. Dapatkan di ${url}`,
  },
} as const

export const keyDialogStrings = (lang: Lang = tuiLang()) => KEY_DIALOG[lang]

const GETTING_STARTED = {
  en: {
    title: "Getting started",
    body: "Ezkielyna Agent runs on your Ezkielyna API key.",
    get: `Get a key at ${EZK.keysURL.replace("https://", "")} (Flash Plan: ${EZK.storeURL.replace("https://", "")}).`,
    enter: "Enter API key",
    start: "Get started",
  },
  id: {
    title: "Mulai di sini",
    body: "Ezkielyna Agent berjalan dengan kunci API Ezkielyna Anda.",
    get: `Dapatkan kunci di ${EZK.keysURL.replace("https://", "")} (Flash Plan: ${EZK.storeURL.replace("https://", "")}).`,
    enter: "Masukkan kunci API",
    start: "Mulai",
  },
} as const

export const gettingStartedStrings = (lang: Lang = tuiLang()) => GETTING_STARTED[lang]
