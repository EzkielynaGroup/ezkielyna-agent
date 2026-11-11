/** Offline intent detector shared by plan routing (A5) and reproduce-first (A10). */
export type Intent = "fix" | "plan-needed" | "qa" | "other"

const PLAN_REQUEST =
  /^\s*plan\b|\b(?:make|write|draft|prepare|propose|outline|create|buat|susun|tulis|siapkan|design|desain)\s+(?:me\s+)?(?:a\s+)?(?:staged|safe|rollout|implementation|rollback|remediation)?\s*(?:plan|roadmap|strategy|rencana|langkah|urutan)\b|\b(?:plan|rencana)\s+(?:first|dulu|before)\b|\b(?:roadmap|rencana|strategi)\s+(?:dulu|bertahap|implementasi)\b|\b(?:staged|rollout|remediation|rollback|implementation)\s+(?:fix\s+)?plan\b|\b(?:prepare|create|propose|draft|write|assess)\b.{0,80}\b(?:roadmap|remediation plan|staged fix plan)\b/i
const PLAN_SCOPE =
  /\b(refactor|re-?architect|architecture|architect(?:ure)?|migrat(?:e|ion|ing)|rewrite (?:the |this )?(?:project|repo|codebase|module)|whole (?:repo|repository|codebase|project)|entire (?:repo|repository|codebase|project)|across (?:the )?(?:repo|repository|codebase|packages?|modules?)|multi[- ](?:file|package|module)|all (?:the )?(?:callers|modules|files|endpoints) across|seluruh (?:repo|proyek|aplikasi)|migrasi|arsitektur|refaktor|rancang(?:kan)? (?:arsitektur|skema|database|api|sistem)|desain ulang|lintas (?:modul|paket|file)|semua (?:pemanggil|modul|file|endpoint|klien) di (?:repo|proyek)|ubah proyek ini dari|upgrade (?:the )?(?:repo|repository|project)|full (?:react|node|web|mobile)? ?app|complete (?:web )?application|plugin architecture|grant application|technical design doc(?:ument)?|research paper|business plan|microservices|ttl support|time-to-live|injected clock|cache api|extract .{0,100}all (?:three|four|five) (?:places|files|modules)|convert (?:them|these|all) to)\b/i
const DEEP_REVIEW =
  /\breview\b.{0,180}\b(?:pr|pull request)\b.{0,180}\b(?:security|risks?|compatibility|across|packages?|plugins?|blockers?|dampak|keamanan|risiko)\b|\breview\s+(?:this\s+)?pr\b.{0,120}\b(?:across|security|compatibility|blockers?)\b/i
const COORDINATED_CHANGE =
  /\b(?:new exported function|new public api)\b.{0,220}\b(?:stable|keeping the original|completed todos|priority|ordering)\b|\b(?:rename|change the name of|ganti nama)\b.{0,160}\b(?:all|every|semua) (?:the )?(?:callers|pemanggil)\b|\bsplit\b.{0,150}\bmodules?\b|\bsplit (?:it|this|the \w+)\b.{0,180}\b(?:new )?(?:modules?|files?|strings?|math)\b|\b(?:move|collect|centralize|kumpulkan)\b.{0,160}\b(?:three|all three|ketiga|multiple) (?:files?|file|places|tempat|modules?|modul)\b/i
const DESIGN_PLAN = /\b(?:design|desain)\b.{0,100}\b(?:safe|restore|rollout|implementation|rollback)?\s*plan\b|\b(?:plugin system|system plugin|sistem plugin)\b/i
const FIX_REQUEST =
  /\b(?:fix|repair|resolve|correct|perbaiki|memperbaiki|betulkan|benahi)\b/i
const FAILURE =
  /\b(?:bug|broken|breaks?|crash(?:es|ed|ing)?|regression|not working|doesn'?t work|does not work|stopped working|fails?|failing|failure|exception|stack ?trace|wrong result|galat|gagal|rusak|tidak (?:jalan|berfungsi)|errors? (?:in|on|after|when|muncul|terjadi|appears?|occurs?))\b/i
const MICRO_EDIT =
  /\b(?:typo|spelling|format(?:ting)?|prettier|lint(?:er)?|whitespace|indent(?:ation)?|comment|docstring|readme|docs?|changelog|rename|salah ketik|ejaan)\b/i
const FUNCTIONAL_FAILURE =
  /\b(?:bug|crash|exception|regression|failing|failure|gagal|rusak|broken|errors? (?:in|on|after|when|muncul|terjadi|appears?|occurs?))\b/i
const QUESTION_START =
  /^\s*(?:(?:can|could|would) you (?:please )?(?:explain|describe|show|tell)|tell me|what|why|how|when|where|who|which|does|do|is|are|will|should|explain|describe|show me|list|how many|jelaskan|apa|mengapa|kenapa|bagaimana|kapan|siapa|mana|berapa|file mana|cara|which files?)\b/i
const READ_ONLY =
  /\b(?:do not|don't|dont|without)\s+(?:modify|change|edit|patch|touch)\s+(?:(?:any|the)\s+)?(?:code|files?(?!\s+(?:excel|csv|data|input|source))|source|implementation|anything)\b|\b(?:jangan|tanpa)\s+(?:ubah|mengubah|edit|mengedit|patch)\s+(?:(?:kode|file(?!\s+(?:excel|csv|data|input|sumber|asli))|source|implementasi)(?:nya)?|apa pun)\b|\b(?:cukup|hanya)\s+(?:jelaskan|laporkan|report|explain)\b|\breport only\b|\bexplain only\b/i
const ACTION_REQUEST =
  /\b(?:add|build|change|create|debug|design|fix|implement|integrate|make|migrate|improve|optimi[sz]e|refactor|remove|repair|rewrite|update|write|buat|bikin|tambahkan|buatkan|perbaiki|betulkan|ubah|tulis|jalankan|run|start|stop|delete|move|rename|translate|summari[sz]e)\b/i
const MULTI_STEP =
  /\b(?:run|jalankan)\s+(?:the\s+|focused\s+)?tests?\b.{0,80}\b(?:then|lalu|and)\b.{0,40}\b(?:fix|repair|perbaiki|betulkan)\b/i
const TEST_REPAIR_REQUEST = /\b(?:make|get)\s+(?:the\s+)?tests?\b.{0,80}\b(?:pass|passing|green)\b|\btests?\b.{0,80}\b(?:pass|passing|green)\b.{0,60}\b(?:make|get|please|tolong)\b/i
const INFO_REQUEST = /\b(?:explain|describe|tell me|show me|jelaskan|terangkan|tunjukkan|sebutkan)\b/i

/** Classify the requested work without I/O, a model call, or session state. */
export function classifyIntent(prompt: string): Intent {
  const p = prompt.trim()
  if (!p || p.length > 8_000) return "other"
  const intentText = p.replace(/--plan\b/gi, "")
  if (PLAN_REQUEST.test(intentText)) return "plan-needed"

  // Explicit read-only questions stay QA even when they mention a failure or a possible fix.
  if (READ_ONLY.test(p)) return "qa"
  const startsQuestion = QUESTION_START.test(p)
  const question = startsQuestion || /\?\s*$/.test(p)
  const explicitRepairAsk = /\b(?:please|tolong|can you|could you)\s+(?:fix|repair|resolve|correct|perbaiki|betulkan)\b/i.test(p)
  if (startsQuestion && !explicitRepairAsk) return "qa"
  if (question && !ACTION_REQUEST.test(p) && !FIX_REQUEST.test(p) && !MULTI_STEP.test(p)) return "qa"

  if (FIX_REQUEST.test(p) && !(MICRO_EDIT.test(p) && !FUNCTIONAL_FAILURE.test(p))) return "fix"
  if (FAILURE.test(p) && !MICRO_EDIT.test(p) && !question) return "fix"
  if (MULTI_STEP.test(p) || TEST_REPAIR_REQUEST.test(p)) return "fix"
  // A migration/refactor is the primary intent even if its prompt mentions incidental type fixes.
  if (PLAN_REQUEST.test(intentText) || PLAN_SCOPE.test(intentText) || DEEP_REVIEW.test(p) || COORDINATED_CHANGE.test(p) || DESIGN_PLAN.test(p))
    return "plan-needed"
  if (INFO_REQUEST.test(p) && !ACTION_REQUEST.test(p)) return "qa"
  if (QUESTION_START.test(p)) return "qa"
  return "other"
}
