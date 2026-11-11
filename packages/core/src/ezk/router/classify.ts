// Ezkielyna Agent: heuristic turn classifier. Pure, no I/O, microseconds.
// Calibrated offline on the fixed 250-prompt v2 split (test/ezk/fixtures/router-labels.md and router-calibration.test.ts).
// Bias: when unsure, heavy. A light keyword never cancels a strong heavy hint.
import type { Tier } from "../contracts"

export interface TurnSignals {
  prompt: string
  /** distinct files read/edited so far in this session */
  filesTouched?: number
  /** current prompt size in tokens */
  contextTokens?: number
  /** consecutive steps whose shell command failed (tests/build) */
  failingLoop?: number
  /** tool errors in the last few steps */
  toolErrors?: number
  planMode?: boolean
  hasImages?: boolean
}

export interface Classification {
  tier: Tier
  score: number
  reasons: string[]
  /** Score is in the band where the optional tiny classifier may break the tie. */
  ambiguous: boolean
}

// Strong heavy words: one hit is enough (+28). Whole-project scope, design work, hard debugging, big writing.
const HEAVY_KW = [
  /\b(refactor|re-?architect|migrat(e|ion)|redesign|rewrite(?! (this|the|my|a) (sentence|paragraph|text|email|message|caption|line|bio|title))|overhaul|design (a|the) (system|architecture)|design .{0,100}\b(plan|roadmap)|root cause|race condition|deadlock|memory leak|security (audit|review)|performance (profil|regress)|across (the |my |this )?(repo|codebase|project|app|modules?|packages?)|whole (repo|codebase|project|app)|entire (repo|codebase|project|app|folder|docs)|multi[- ]file|implement .{0,40}(feature|module|service|pipeline)|debug(ging)? .{0,30}(flaky|intermittent|crash)|flaky|intermittent(ly)?|(?:make|write|draft|prepare|create) (a )?(detailed )?plan|prepare .{0,60}(roadmap|remediation plan)|plan (first|before))\b/i,
  /\b(refaktor|migrasi|desain ulang|tulis ulang|rancang|arsitektur|akar masalah(?:nya)?|bug (aneh|sulit)|seluruh (?:repo|codebase|proyek)|banyak file|fitur baru|audit|optimasi performa|memory leak|race condition|multi[- ]tenant|ubah proyek)\b/i,
  /\breview\b.{0,100}\bPR\b.{0,100}\b(security|risks?|compatibility|across|packages?|plugins?|blockers?)\b|\b(cari|search|find) (?:in |di )?(?:the )?repo\b.{0,80}\b(all|every|semua|seluruh|setiap|legacy)\b/i,
  /\breview (?:this )?PR\b/i,
  /\b(?:explain|trace|describe|jelaskan)\b.{0,160}\b(?:repository|repo|codebase|alur data)\b.{0,160}\b(?:files?|where|stored|written|database|abuse|across)\b/i,
  /\bmake (?:the )?tests?\b.{0,100}\b(?:pass|passing|green)\b/i,
  /\b(?:make|write|draft|prepare|create|buat|susun|tulis|siapkan) (?:a )?(?:detailed )?(?:plan|rencana|roadmap|langkah)\b|\b(?:plan|rencana) (?:first|dulu|before)\b/i,
]
// Medium heavy words (+18 each, a second one stacks): "build/create a whole thing", many-step or long deliverables.
const HEAVY_MED = [
  /\b(build|create|make|develop|implement|write|set up) (me )?(an? |the )?(full|complete|whole|new|simple|small)?\s?(\w+ )?(app|application|website|web ?site|api|backend|frontend|system|platform|tool|bot|chatbot|game|dashboard|pipeline|workbook|suite|plugin)\b/i,
  /\b(buat(kan)?|bikin|kembangkan|bangun|susun|tulis(kan)?|rancang) (aplikasi|website|situs|sistem|game|chatbot|bot|dashboard|modul|plugin|proposal|makalah|skripsi|laporan)\b/i,
  /\b(every|all (the |of the |my )?(\w+ )?(files?|modules?|endpoints?|pages?|tests?|callers|usages|places|errors|bugs|warnings|components?|classes|functions?|services|routes|screens|templates)|every (public |single )?(\w+)|keeps? (failing|crash)|intermittent|comprehensive|end[- ]to[- ]end|ci\/cd|authentication|oauth|upgrade .{0,25}\bto\b|port .{0,40}\bto\b|convert (the |all |every |this )?(project|codebase|stylesheets?|everything)|find (out )?(why|the cause)|figure out (what|why)|profil(e|ing)|optimi[sz]e)\b/i,
  /\b(?:kenapa (?:test|error|gagal|aplikasi|build|deploy).{0,60}(?:terus|lagi|kadang|tetap|berulang)|kadang (?:lolos|gagal|error)|perbaiki semua (?:bug|error|masalah)|cari penyebab|penyebab (?:kenapa|mengapa)|profiling|optimasi|autentikasi|konversi|migrasi|komprehensif|laporan lengkap|lengkap dengan|beserta test|integrasi)\b/i,
  /\b(makalah|skripsi|dissertation|proposal|research paper|design doc(ument)?|grant application|business plan|rpp|modul ajar|cerpen|e-?book)\b/i,
  /\b(implement(asi|asikan)?|(integration|e2e|end-to-end|regression) tests?|etl|data pipeline|real-?time|websocket|concurren(t|cy)|distributed|scalab(le|ility)|caching|queue|docker|kubernetes|microservices?|crdt|webpack|ci cache)\b/i,
  /\b(clean (up )?(this|the|these) .{0,40}(dataset|data|spreadsheet)|merge .{0,30}(files?|datasets?|tables?)|compare .{0,30}(algorithms?|models?|approaches)|bandingkan .{0,20}(algoritma|model)|debug why|slower than|prediksi|model prediksi|regresi|machine learning|dashboard)\b/i,
  /\b(reorgani[sz]e|restructur(e|ing)|reorganisasi|susun ulang|bottlenecks?|investigate|selidiki|diagnos(e|is)|scrap(er|ing)|crawler|e-?commerce|toko online|marketplace|booking platform|load tests?|(takes?|butuh|memakan) \d+ (seconds?|detik|menit|minutes?)|chapter|bab \d|folder structure|struktur folder|import paths?|tiap kali|setiap kali|random(ly)?|sporadis|sering (hang|crash|error|lambat)|(i'?ve|i have) tried|sudah (saya )?(coba|cek|ubah)|nothing helps|tidak ada pesan|no (clear )?error message)\b/i,
  /\b(force[- ]close|crash(es|ed|ing)?|hangs?|silently|(fails?|failed|failing) (when|on|after|only)|(pass|passes|passed) .{0,40}(but|except)|dropped|broke|broken|wrong with|stopped working|production-ready|series of|turn (it|this|that) into|look through|dig (in|into)|cari tahu|tidak (jalan|berfungsi)|berhenti (jalan|berfungsi)|turun \d+|(in|di) production)\b/i,
  /\b(lewat|melewati|spanning|across) \d+ (file|files|modules?|layers?)\b/i,
  /\b\d{2,}[- ]?(files?|file|errors?|failures|halaman|pages?|words?|kata|slides?)\b/i,
  /\b(?:run|jalankan) (?:(?:the )?(?:focused )?)?tests?\b.{0,80}\b(?:then|lalu|and)\b.{0,40}\b(?:fix|repair|perbaiki|betulkan)\b|\btests?\b.{0,60}\b(?:fail|failing|gagal|merah)\b.{0,80}\b(?:fix|repair|perbaiki|betulkan)\b/i,
  /\b(?:two|2|new) (?:exported )?functions?\b.{0,360}\b(?:priority|sort|completed|stable)\b|\b(?:ttl|time-to-live)\b.{0,80}\b(?:cache|injectable|clock|api)\b|\bmake (?:the )?tests?\b.{0,100}\b(?:pass|passing|green)\b/i,
  /\b(?:roadmap|remediation) plan\b|\b(?:retries?|all \d+ ci checks|across (?:two|\d+) packages?|(?:several|multiple|beberapa|banyak) (?:files?|modules?|paket|modul))\b/i,
]
const LIGHT_KW = [
  /\b(rename|typo|fix (the )?(typo|lint|format)|add (a )?(comment|docstring|log)|explain|what does|what is|show me|list|summari[sz]e|translate|bump|format|prettier|commit message|git (status|diff|log)|run (the )?tests?|hello world)\b/i,
  /\b(ganti nama|salah ketik|jelaskan|apa itu|tampilkan|daftar|ringkas|terjemah|jalankan test|buat(kan)? (file|fungsi) (kecil|sederhana))\b/i,
  /\b(?:tiny|small|focused|single[- ]file) (?:cli|script|helper|function|change|edit|test|endpoint)\b|\badd (?:two |a |one )?(?:simple )?(?:flags?|parameters?|endpoints?|routes?|functions?|methods?)\b|\b(?:focused|existing) test (?:fails|failed|failure)\b/i,
  /\b(?:rapikan|organize|sort|rename|move) (?:this |the )?(?:folder|files?)\b|\b(?:calculate|hitung) (?:the )?total(?:nya)?\b|\b(?:from|dari) (?:file )?[\w./-]+\.(?:txt|csv|xlsx?)\b.{0,160}\b(?:summary|ringkasan|low.?stock|filter|total|per city|per kota)\b/i,
  /\b(?:which|what|how many) (?:functions?|files?|callers?) (?:would|will|call|use|break)|\b(?:do not|don't) (?:change|modify) (?:any )?(?:code|files?)\b/i,
  /\b(?:read-only|without editing|do not modify|don't edit|jangan edit|jangan ubah kode)\b/i,
  /\b(?:what|why|how|when|where|who|which|does|do|is|are|apa|kenapa|bagaimana|kapan|siapa|mana|berapa)\b/i,
  /\bread (?:the )?(?:excel|csv) file\b.{0,160}\b(?:create|write|make|buat|tulis)\b.{0,60}\.csv\b/i,
]

export const HEAVY_THRESHOLD = 48
export const AMBIGUOUS_BAND: [number, number] = [38, 58]

export function classify(s: TurnSignals): Classification {
  const reasons: string[] = []
  let score = 30 // prior: coding-agent turns skew light
  const p = s.prompt.trim()
  const words = p ? p.split(/\s+/).length : 0
  if (words > 220) {
    score += 22
    reasons.push(`long prompt (${words}w)`)
  } else if (words > 90) {
    score += 12
    reasons.push(`medium prompt (${words}w)`)
  }
  const strong = HEAVY_KW.some((r) => r.test(p))
  // asking for ideas/titles/examples about a big document type is a small task
  const smallAsk = /\b(ide|topik|judul|contoh|idea|ideas|topic|topics|title|titles|example|examples|sinonim|synonyms?)\b/i.test(p)
  const localFileBatch =
    /\b(rename|move|sort|organize|rapikan|pindahkan)\b.{0,90}\b(?:all|every|semua|seluruh)?\s*(?:files?|file|photos?|documents?|foto|dokumen)\b/i.test(p) &&
    !/\b(repo|repository|codebase|project|across|seluruh proyek|seluruh repo)\b/i.test(p)
  const focusedCallerQuestion =
    /\b(?:which|what|how many)\b.{0,100}\b(?:callers?|functions?)\b/i.test(p) &&
    /\b(?:src\/|\.ts\b|\.go\b|\.py\b)/i.test(p) &&
    !/\b(?:across (?:the )?(?:repo|codebase|project)|whole repo|all packages?)\b/i.test(p)
  const focusedDataTransform =
    /\b(?:read (?:the )?(?:excel|csv) file|(?:from|dari|di) (?:file )?[\w./-]+\.(?:txt|csv|xlsx?))\b/i.test(p) &&
    /\b(?:create|write|make|buat|tulis|calculate|hitung|total|summary|ringkasan|filter|low_stock)\b/i.test(p) &&
    !/\b(?:merge|clean(?:ed)?|normaliz[es]|normalis(?:e|ed)|deduplicate|duplicates?|compare|model|dashboard|reconcile|rekonsiliasi)\b/i.test(p)
  const sourcePathCount = (p.match(/\b(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|py|go|rs|java|cs|json|md|ya?ml)\b/gi) ?? []).length
  const medium = Math.max(
    0,
    HEAVY_MED.filter((r) => r.test(p)).length -
      (smallAsk && /\b(makalah|skripsi|proposal|thesis|essay|esai)\b/i.test(p) ? 1 : 0) -
      (localFileBatch || focusedCallerQuestion || focusedDataTransform ? 1 : 0) +
      (sourcePathCount >= 3 ? 1 : 0),
  )
  if (strong) {
    score += 28
    reasons.push("heavy keyword")
  }
  if (medium) {
    score += Math.min(medium, 3) * 18
    reasons.push(`${medium} heavy hint${medium > 1 ? "s" : ""}`)
  }
  // Safety bias: a light keyword never cancels a heavy one (sending heavy work to the light model is the worse mistake).
  if (!strong && !medium && LIGHT_KW.some((r) => r.test(p))) {
    score -= 22
    reasons.push("light keyword")
  } else if (!strong && !medium && words < 14) {
    score -= 10
    reasons.push("short prompt")
  }
  // Length is a modest signal: v2 adds verbose single-file, file-management, and focused Q&A prompts, so scope cues matter more.
  if (!strong && !LIGHT_KW.some((r) => r.test(p))) {
    if (words >= 18) {
      score += 14
      reasons.push("long request, no light cue")
    } else if (words >= 15) {
      score += 8
      reasons.push("longish request, no light cue")
    }
  }
  // many items in one sentence (a, b, c, and d) = a multi-part request
  const commas = (p.match(/,/g) ?? []).length
  if (commas >= 3 && words > 12) {
    score += 10
    reasons.push("multi-part list")
  }
  const bullets = (p.match(/^\s*([-*]|\d+[.)])\s+/gm) ?? []).length
  if (bullets >= 4) {
    score += 10
    reasons.push(`${bullets} requirements listed`)
  }
  if (/```|\bstack trace\b|\bTraceback\b|\bat .+:\d+:\d+/.test(p)) {
    score += 8
    reasons.push("pasted code/trace")
  }
  const files = s.filesTouched ?? 0
  if (files >= 6) {
    score += 14
    reasons.push(`${files} files touched`)
  } else if (files >= 3) score += 6
  const loop = s.failingLoop ?? 0
  if (loop >= 2) {
    score += 30
    reasons.push(`failing loop x${loop}`)
  } else if (loop === 1) score += 8
  if ((s.toolErrors ?? 0) >= 3) {
    score += 8
    reasons.push("repeated tool errors")
  }
  if ((s.contextTokens ?? 0) > 60_000) {
    score += 8
    reasons.push("large context")
  }
  if (s.planMode) {
    score += 25
    reasons.push("plan mode")
  }
  score = Math.max(0, Math.min(100, score))
  return {
    tier: score >= HEAVY_THRESHOLD ? "heavy" : "light",
    score,
    reasons,
    ambiguous: score >= AMBIGUOUS_BAND[0] && score <= AMBIGUOUS_BAND[1],
  }
}

/** `@heavy` / `@light` at the start of a message forces the tier for that message only. The prefix is removed. */
export function parseTierPrefix(text: string): { forced?: Tier; text: string } {
  const m = /^\s*@(heavy|light)\b[ \t]*/i.exec(text)
  if (!m) return { text }
  return { forced: m[1]!.toLowerCase() as Tier, text: text.slice(m[0].length) }
}

export const TINY_SYSTEM =
  "Classify a coding-agent request. Answer ONE word: heavy (multi-file change, design, hard debugging, security, ambiguous spec) or light (small edit, question, explanation, single command)."

/** Optional tie-breaker for ambiguous turns with a hard time budget; any failure returns undefined (heuristic wins). */
export async function tinyClassify(
  prompt: string,
  call: (system: string, user: string, signal: AbortSignal) => Promise<string>,
  budgetMs = 300,
): Promise<Tier | undefined> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), budgetMs)
  try {
    const out = await Promise.race([
      call(TINY_SYSTEM, prompt.slice(0, 1500), ac.signal),
      new Promise<string>((_, reject) => ac.signal.addEventListener("abort", () => reject(new Error("budget")))),
    ])
    const word = out.toLowerCase()
    return word.includes("heavy") ? "heavy" : word.includes("light") ? "light" : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
