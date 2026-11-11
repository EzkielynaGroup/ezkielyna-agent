// Ezkielyna Agent: pure brand constants (no node imports, safe to bundle into the browser/desktop renderer).
/** The OpenCode release this build is based on (npm plugin SDK version, merge base). */
export const EZK_UPSTREAM_VERSION = "1.19.3"

/** Baked in at build time (opencode/script/build.ts, build-node.ts) from EZK_UPDATE_URL; empty = no update checks. */
declare const EZK_DEFAULT_UPDATE_URL: string | undefined

const env = (name: string) => (typeof process !== "undefined" ? process.env[name] : undefined)

export const EZK = {
  /** Product name shown to users. */
  name: "Ezkielyna Agent",
  /** CLI command name (an `ezk` alias ships next to it). */
  command: "ezkielyna",
  appId: "store.ezkielyna.agent",
  providerID: "ezkielyna",
  providerName: "Ezkielyna",
  /** OpenAI-compatible gateway. Override with EZKIELYNA_BASE_URL (testing, future mirrors). */
  baseURL: (env("EZKIELYNA_BASE_URL") || "https://api.ezkielyna.store/v1").replace(/\/+$/, ""),
  envKey: "EZKIELYNA_API_KEY",
  keysURL: "https://api.ezkielyna.store/keys",
  storeURL: "https://ezkielyna.store",
  supportGroupUrl: "https://chat.whatsapp.com/L6igdMdMsuz4eAdKe6jHUC",
  /**
   * Preferred default model, used when the key is allowed to use it.
   * 2026-10-21 benchmark (scripts/bench, bench-results/): minimax-m3.1-flash 27/27 tasks correct, 0 tool errors,
   * so per the owner's rule it is the default. deepseek-v4.1-flash was ~30% faster in the same test (TTFT 1.8 s vs
   * 3.8 s) but had recoverable tool errors; flip this one line if speed matters more than tool-call cleanliness.
   */
  defaultModel: "auto",
  /**
   * Tried in this order when `defaultModel` is not allowed for the key. `default-model` is the "Auto" alias of the
   * normal key group; Flash/Luna plan keys have neither alias and land on minimax-m3.1-flash.
   * (2026-10-21 benchmark, 54 runs: auto, default-model, balanced-model, fast-model all handled tool calls with 0 tool errors.)
   */
  defaultModelFallbacks: [
    "default-model",
    "minimax-m3.1-flash",
    "deepseek-v4.1-flash",
    "mimo-v2.6-flash",
    "deepseek-v4.1-flash-1017",
    "glm-5.3-flash",
  ],
  /** Titles and other small tasks: cheapest alias first. */
  smallModelPreference: ["fast-model", "auto", "deepseek-v4.1-flash", "minimax-m3.1-flash"],
  /** Shown when /v1/models cannot be reached and nothing is cached. */
  fallbackModels: ["default-model", "minimax-m3.1-flash", "deepseek-v4.1-flash", "mimo-v2.6-flash"],
  /**
   * Update hook. Empty = no update checks at all (default).
   * Point it at a directory that serves `latest.json` (`{"version":"1.2.3","notes":"...","url":"https://.../downloads/"}`)
   * and, for the desktop app, the electron-updater `latest-mac.yml`/`latest.yml`/`latest-linux.yml` files.
   */
  updateURL: (
    env("EZK_UPDATE_URL") ||
    (typeof EZK_DEFAULT_UPDATE_URL === "string" ? EZK_DEFAULT_UPDATE_URL : "") ||
    ""
  ).replace(/\/+$/, ""),
  /** "Masuk dengan akun Ezkielyna" (browser/device login). Designed, hidden until the server side exists. */
  /**
   * Gateway aliases that pick a model per request, shown as "Auto" in the pickers.
   * `auto` only exists in the free/Hemat group (routes to a Hunyuan model); `default-model`, `balanced-model` and
   * `fast-model` are the same idea for the normal group (see /api/pricing descriptions).
   */
  autoModels: { auto: "Auto", "default-model": "Auto", "balanced-model": "Auto Balanced", "fast-model": "Auto Fast" } as Record<string, string>,
  autoHint: { en: "picks the best model automatically", id: "memilih model terbaik otomatis" },
  /** Store endpoints used by the account features (login, plan/quota). Probed at runtime, see ezkielyna-account.ts. */
  storeApi: (env("EZK_STORE_API_URL") || "https://ezkielyna.store").replace(/\/+$/, ""),
  accountLoginEnabled: env("EZK_ACCOUNT_LOGIN") === "1",
  /** Name of the CLI/server log file in the log dir. Older installs wrote `legacyLogFile`; it is left in place and still read by bug reports. */
  logFile: "ezkielyna.log",
  legacyLogFile: "opencode.log",
  /** The one place the upstream name is correct: MIT attribution. */
  notice: "Based on OpenCode (MIT), © its authors",
} as const

/** Rewrites upstream product names in translated UI strings (all locales) so we do not fork 60 dictionaries. */
export const brandText = (text: string) => text.replace(/OpenCode/g, "Ezkielyna Agent")

export const isAutoModel = (id: string) => Object.prototype.hasOwnProperty.call(EZK.autoModels, id)
export const autoHint = (lang?: string) => (lang && lang.toLowerCase().startsWith("id") ? EZK.autoHint.id : EZK.autoHint.en)
