// Ezkielyna Agent: friendly Indonesian/English messages for the gateway's real error shapes.
// Observed bodies (New API, 21 Oct 2026):
//   401 {"error":{"message":"Invalid token (request id: ...)","type":"new_api_error"}}   bad, deleted or exhausted key
//   403 {"error":{"message":"无权访问 flash100 分组 (request id: ...)"}}                  key group not allowed
//   503 {"error":{"code":"model_not_found","message":"No available channel for model X under group default ..."}}
//   429 / 503 upstream busy (retried with back-off by the session loop, 5xx always, 429 honouring Retry-After)
import { EZK } from "./ezkielyna-brand"

export type Lang = "id" | "en"

export function detectLang(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): Lang {
  const raw = env.EZK_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().locale : "") || ""
  return /^(id|in|ms)\b/i.test(raw) || /^id[-_]/i.test(raw) ? "id" : "en"
}

type Kind = "no_key" | "bad_key" | "no_balance" | "plan_cap" | "group_denied" | "rate_limit" | "model_missing" | "busy" | "network" | "stream_cut"

/** Where the message will be read: the full-screen app (it has /connect) or a plain command line (it has `ezkielyna auth login`). */
export type Surface = "tui" | "cli"

export type ErrorContext = {
  /** Is an Ezkielyna credential configured at all (auth.json entry, config key or EZKIELYNA_API_KEY)? false turns "bad key" into "no key yet". */
  hasKey?: boolean
  surface?: Surface
}

/** `EZK_SURFACE=tui` is set by the TUI command before it starts its worker; everything else is a command line. */
export function detectSurface(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): Surface {
  return env.EZK_SURFACE === "tui" ? "tui" : "cli"
}

const TEXT: Record<Kind, { id: (m?: string, s?: Surface) => string; en: (m?: string, s?: Surface) => string }> = {
  no_key: {
    id: (_, s) => `Belum ada kunci API. Dapatkan di ${EZK.keysURL}, lalu ${s === "tui" ? "masukkan dengan /connect" : "jalankan: ezkielyna auth login"}`,
    en: (_, s) => `No API key yet. Get one at ${EZK.keysURL}, then ${s === "tui" ? "enter it with /connect" : "run: ezkielyna auth login"}`,
  },
  bad_key: {
    id: (_, s) => `Kunci API tidak valid, sudah dihapus, atau saldonya habis. Periksa kunci Anda di ${EZK.keysURL} lalu masukkan lagi dengan ${s === "tui" ? "/connect" : "perintah: ezkielyna auth login"}.`,
    en: (_, s) => `The API key is invalid, deleted, or out of balance. Check your key at ${EZK.keysURL} and enter it again with ${s === "tui" ? "/connect" : "the command: ezkielyna auth login"}.`,
  },
  no_balance: {
    id: () => `Saldo atau kuota habis. Isi saldo atau tambah paket di ${EZK.storeURL}.`,
    en: () => `Balance or quota is used up. Top up or add a plan at ${EZK.storeURL}.`,
  },
  plan_cap: {
    id: () => `Batas pemakaian paket Anda sudah tercapai. Tunggu reset, atau tingkatkan paket di ${EZK.storeURL}.`,
    en: () => `Your plan's usage cap has been reached. Wait for the reset, or upgrade your plan at ${EZK.storeURL}.`,
  },
  group_denied: {
    id: () => `Kunci ini tidak bisa dipakai untuk paket tersebut. Pilih model lain atau cek paket Anda di ${EZK.storeURL}.`,
    en: () => `This key is not allowed to use that group or plan. Pick another model or check your plan at ${EZK.storeURL}.`,
  },
  rate_limit: {
    id: () => "Terlalu banyak permintaan. Mencoba lagi otomatis sebentar lagi.",
    en: () => "Too many requests. Retrying automatically in a moment.",
  },
  model_missing: {
    id: (m) => `Model${m ? ` “${m}”` : ""} tidak tersedia untuk kunci ini. Pilih model lain (ctrl+p lalu Model, atau /models).`,
    en: (m) => `Model${m ? ` “${m}”` : ""} is not available for this key. Pick another model (ctrl+p then Models, or /models).`,
  },
  busy: {
    id: () => "Layanan model sedang sibuk. Mencoba lagi otomatis; kalau terus begini, pilih model lain.",
    en: () => "The model service is busy. Retrying automatically; if it keeps happening, pick another model.",
  },
  network: {
    id: () => `Tidak bisa terhubung ke ${new URL(EZK.baseURL).host}. Periksa koneksi internet Anda, lalu coba lagi.`,
    en: () => `Cannot reach ${new URL(EZK.baseURL).host}. Check your internet connection and try again.`,
  },
  stream_cut: {
    id: () => "Koneksi ke gateway terputus di tengah jawaban. Coba lagi.",
    en: () => "The connection to the gateway dropped in the middle of the answer. Please try again.",
  },
}

const NETWORK = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|Unable to connect|Cannot connect|network|socket hang up/i
const QUOTA_WORDS = /额度|余额|quota|balance|insufficient|credit|payment/i
const PLAN_WORDS = /每日|当日|套餐|daily|per day|plan|package|usage cap|limit reached/i

function body(responseBody: string | undefined): { code?: string; message?: string } {
  if (!responseBody) return {}
  try {
    const parsed = JSON.parse(responseBody)
    const e = parsed?.error ?? parsed
    return { code: typeof e?.code === "string" ? e.code : undefined, message: typeof e?.message === "string" ? e.message : typeof parsed?.message === "string" ? parsed.message : undefined }
  } catch {
    return { message: responseBody.slice(0, 300) }
  }
}

export function classifyGatewayError(input: { status?: number; responseBody?: string; message?: string }, ctx: ErrorContext = {}): { kind: Kind; model?: string } | undefined {
  const b = body(input.responseBody)
  const text = `${b.message ?? ""} ${input.message ?? ""}`
  const status = input.status
  if (b.code === "model_not_found" || /No available channel for model/i.test(text) || (status === 404 && /model/i.test(text))) {
    return { kind: "model_missing", model: /model\s+([\w.\-/:]+)\s+under group/i.exec(text)?.[1] }
  }
  if (status === 401 || /invalid token|incorrect api key|invalid api key/i.test(text)) return { kind: ctx.hasKey === false ? "no_key" : "bad_key" }
  if (status === 429 || /rate.?limit|too many requests|请求过于频繁/i.test(text)) return { kind: PLAN_WORDS.test(text) && !/rate/i.test(text) ? "plan_cap" : "rate_limit" }
  if (status === 402 || (status === 403 && QUOTA_WORDS.test(text))) return { kind: PLAN_WORDS.test(text) ? "plan_cap" : "no_balance" }
  if (status === 403 && /分组|group/i.test(text)) return { kind: "group_denied" }
  if (status === undefined && NETWORK.test(text)) return { kind: "network" }
  if (status !== undefined && status >= 500) return { kind: "busy" }
}

/** Friendly text, or undefined when the error is not one we recognise (callers then keep the original message). */
export function friendlyGatewayError(
  input: { status?: number; responseBody?: string; message?: string },
  lang: Lang = detectLang(),
  ctx: ErrorContext = {},
): string | undefined {
  const c = classifyGatewayError(input, ctx)
  if (!c) return
  return TEXT[c.kind][lang](c.model, ctx.surface ?? detectSurface())
}

/** The sentence for "there is no credential at all" (used before any request, e.g. by `doctor` and the CLI). */
export function noKeyMessage(lang: Lang = detectLang(), surface: Surface = detectSurface()): string {
  return TEXT.no_key[lang](undefined, surface)
}

/** Friendly text for a model stream that was cut after output had already started (not resumable, so it is not retried). */
export function streamCutMessage(lang: Lang = detectLang()): string {
  return TEXT.stream_cut[lang]()
}
