// Ezkielyna Agent v3 (T5): client for the gateway search endpoint POST {gateway}/search.
// Pure and mockable: `fetch`, the key and the base URL are injected. The key is only ever placed in the Authorization header;
// it is never logged, returned or put in an error message.

export const SEARCH_TIMEOUT_MS = 15_000
export const SEARCH_HINT = "use webfetch on a URL to read the page"

export interface SearchParams {
  query: string
  max_results?: number
  time_range?: "day" | "week" | "month" | "year"
  language?: string
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
  published?: string
}

export type SearchOutcome =
  | { ok: true; output: string; count: number; cached: boolean }
  | { ok: false; status: number | "timeout" | "network" | "nokey" | "invalid"; message: string }

const both = (en: string, id: string) => `${en}\n${id}`

export const MESSAGES = {
  nokey: both(
    "web_search is unavailable: no Ezkielyna API key found. Continue without web search.",
    "web_search tidak tersedia: kunci API Ezkielyna tidak ditemukan. Lanjutkan tanpa pencarian web.",
  ),
  invalid: (detail: string) =>
    both(
      `The search request was rejected as invalid (${detail}). Fix the query (1-400 characters) or the options and try once more.`,
      `Permintaan pencarian ditolak karena tidak valid (${detail}). Perbaiki kata kunci (1-400 karakter) atau opsinya, lalu coba sekali lagi.`,
    ),
  401: both(
    "web_search failed: the Ezkielyna API key was not accepted. Tell the user to check or re-enter the key in Settings. Do not retry; continue without web search.",
    "web_search gagal: kunci API Ezkielyna tidak diterima. Minta pengguna memeriksa atau memasukkan ulang kunci di Pengaturan. Jangan coba lagi; lanjutkan tanpa pencarian web.",
  ),
  429: both(
    "web_search limit reached (30 per minute, 500 per day). Stop searching and continue with the information you already have.",
    "Batas pencarian web (web_search) tercapai (30 per menit, 500 per hari). Berhenti mencari dan lanjutkan dengan informasi yang sudah ada.",
  ),
  503: both(
    "Search is temporarily unavailable. Retry at most once later, otherwise continue without it.",
    "Pencarian web sedang tidak tersedia sementara. Coba lagi sekali saja nanti, atau lanjutkan tanpa pencarian.",
  ),
  timeout: both(
    "Search timed out after 15 seconds. Retry at most once with a shorter query, otherwise continue without it.",
    "Pencarian melebihi batas waktu 15 detik. Coba lagi sekali saja dengan kata kunci lebih singkat, atau lanjutkan tanpa pencarian.",
  ),
  network: both(
    "Could not reach the search service. Check the internet connection; continue without web search for now.",
    "Layanan pencarian tidak bisa dihubungi. Periksa koneksi internet; lanjutkan tanpa pencarian web untuk saat ini.",
  ),
  other: (status: number) =>
    both(
      `Search failed (HTTP ${status}). Continue without web search.`,
      `Pencarian gagal (HTTP ${status}). Lanjutkan tanpa pencarian web.`,
    ),
  empty: both(
    "No results. Try different or fewer keywords, or widen time_range; do not repeat the same query.",
    "Tidak ada hasil. Coba kata kunci lain atau lebih sedikit, atau perluas time_range; jangan ulangi pencarian yang sama.",
  ),
}

const clean = (s: unknown, max: number) =>
  (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim().slice(0, max)

export function formatResults(results: SearchResult[]): string {
  const lines = results.map((r, i) => {
    const date = r.published ? ` (${clean(r.published, 40)})` : ""
    const head = `${i + 1}. ${clean(r.title, 200) || clean(r.url, 200)} — ${clean(r.url, 500)}${date}`
    const snippet = clean(r.snippet, 400)
    return snippet ? `${head}\n   ${snippet}` : head
  })
  return `${lines.join("\n")}\n\n${SEARCH_HINT}`
}

export function searchEndpoint(env: Record<string, string | undefined> = process.env): string {
  const base = (env.EZKIELYNA_BASE_URL?.trim() || "https://api.ezkielyna.store/v1").replace(/\/+$/, "")
  return `${base}/search`
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } }
    return clean(body?.error?.message, 160) || "no detail"
  } catch {
    return "no detail"
  }
}

export async function gatewaySearch(input: {
  params: SearchParams
  key: string | undefined
  endpoint?: string
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<SearchOutcome> {
  if (!input.key) return { ok: false, status: "nokey", message: MESSAGES.nokey }
  const query = input.params.query?.trim() ?? ""
  if (query.length < 1 || query.length > 400)
    return { ok: false, status: "invalid", message: MESSAGES.invalid("query must be 1-400 characters") }
  const body: Record<string, unknown> = { query }
  if (input.params.max_results !== undefined)
    body.max_results = Math.min(10, Math.max(1, Math.floor(input.params.max_results)))
  if (input.params.time_range) body.time_range = input.params.time_range
  if (input.params.language) body.language = input.params.language
  const timeout = AbortSignal.timeout(input.timeoutMs ?? SEARCH_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout
  let res: Response
  try {
    res = await (input.fetch ?? fetch)(input.endpoint ?? searchEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.key}` },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    if (timeout.aborted) return { ok: false, status: "timeout", message: MESSAGES.timeout }
    return { ok: false, status: "network", message: MESSAGES.network }
  }
  if (res.status === 400) return { ok: false, status: 400, message: MESSAGES.invalid(await errorDetail(res)) }
  if (res.status === 401) return { ok: false, status: 401, message: MESSAGES[401] }
  if (res.status === 429) return { ok: false, status: 429, message: MESSAGES[429] }
  if (res.status === 502 || res.status === 503) return { ok: false, status: res.status, message: MESSAGES[503] }
  if (!res.ok) return { ok: false, status: res.status, message: MESSAGES.other(res.status) }
  let data: { results?: SearchResult[]; cached?: boolean }
  try {
    data = (await res.json()) as typeof data
  } catch {
    return { ok: false, status: 502, message: MESSAGES[503] }
  }
  const results = Array.isArray(data.results) ? data.results.filter((r) => r && typeof r.url === "string") : []
  if (results.length === 0) return { ok: true, output: MESSAGES.empty, count: 0, cached: !!data.cached }
  return { ok: true, output: formatResults(results), count: results.length, cached: !!data.cached }
}

/** The tool is offered only when the flag is on AND a key exists. Evaluated once per session (frozen tool list). */
export function webSearchAvailable(flagEnabled: boolean, key: string | undefined): boolean {
  return flagEnabled && !!key
}
