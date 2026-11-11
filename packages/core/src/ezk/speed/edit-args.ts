// Ezkielyna Agent v0.9: tolerant `edit` arguments. Pure functions, no I/O (the caller injects `exists`).
// Rule: repair only what is unambiguous. If two readings are possible, change nothing and let the tool fail with
// its normal message so the model re-reads the file. Never pick a path or a span by guessing between candidates.

const KEY_ALIASES: Record<string, "filePath" | "oldString" | "newString" | "replaceAll"> = {
  filepath: "filePath", file_path: "filePath", path: "filePath", file: "filePath", filename: "filePath", file_name: "filePath", target_file: "filePath",
  oldstring: "oldString", old_string: "oldString", oldtext: "oldString", old_text: "oldString", old_str: "oldString", oldstr: "oldString", old: "oldString", search: "oldString", find: "oldString", original: "oldString",
  newstring: "newString", new_string: "newString", newtext: "newString", new_text: "newString", new_str: "newString", newstr: "newString", new: "newString", replace: "newString", replacement: "newString",
  replaceall: "replaceAll", replace_all: "replaceAll", all: "replaceAll",
}

export interface NormalizedEdit {
  args: Record<string, unknown>
  /** human-readable list of repairs, for logs and tests */
  fixes: string[]
}

/** Map alias keys to the canonical ones and coerce a stringly-typed boolean. Canonical keys always win over aliases. */
export function normalizeEditArgs(raw: unknown): NormalizedEdit {
  const fixes: string[] = []
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { args: raw as any, fixes }
  const out: Record<string, unknown> = {}
  const canonical = new Set(["filePath", "oldString", "newString", "replaceAll"])
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (canonical.has(k)) out[k] = v
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (canonical.has(k)) continue
    const target = KEY_ALIASES[k.toLowerCase()]
    if (!target) {
      out[k] = v
      continue
    }
    if (target in out) continue // canonical (or an earlier alias) already set it
    out[target] = v
    fixes.push(`key ${k} -> ${target}`)
  }
  const ra = out.replaceAll
  if (typeof ra === "string") {
    const s = ra.trim().toLowerCase()
    if (s === "true" || s === "false") {
      out.replaceAll = s === "true"
      fixes.push("replaceAll string -> boolean")
    }
  }
  // null optional values: drop
  if (out.replaceAll === null) delete out.replaceAll
  // numbers/null for string params are not repaired: ambiguous.
  return { args: out, fixes }
}

/** Strip wrapper noise from a path string. Returns candidates in priority order (most literal first). */
export function pathCandidates(raw: string, cwd: string, home?: string): string[] {
  const out: string[] = []
  const push = (p: string) => {
    if (p && !out.includes(p)) out.push(p)
  }
  push(raw)
  let s = raw.trim()
  s = s.replace(/^(['"`])(.*)\1$/, "$2").trim()
  s = s.replace(/^<(.*)>$/, "$1")
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(new URL(s).pathname)
    } catch {
      s = s.slice(7)
    }
  }
  s = s.replace(/^@(?=[\w./~-])/, "") // @mention style
  s = s.replace(/[:]\d+(?::\d+)?$/, "") // trailing :line[:col]
  if (/^[A-Za-z]:\\/.test(s) === false) s = s.replace(/\\/g, "/") // windows separators on posix paths
  if (home && (s === "~" || s.startsWith("~/"))) s = home + s.slice(1)
  push(s)
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/"
  const join = (a: string, b: string) => a.replace(/[\\/]+$/, "") + sep + b.replace(/^[\\/]+/, "")
  if (s.startsWith("a/") || s.startsWith("b/")) push(s.slice(2)) // git diff prefixes (relative form only)
  if (s.startsWith("./")) push(s.slice(2))
  // "absolute" path that is really project-relative: /src/x.ts under cwd
  if (s.startsWith("/")) push(join(cwd, s))
  // path that repeats the project directory name: <cwd>/<basename(cwd)>/x -> <cwd>/x is NOT attempted (ambiguous)
  return out
}

/**
 * Resolve an edit path. Relative paths resolve against cwd (existing behaviour). When the literal target does not
 * exist, try the cleaned variants; accept ONLY if exactly one distinct existing file results. Otherwise return the
 * literal resolution untouched so the tool reports "File not found" as before.
 */
export function resolveEditPath(
  raw: string,
  opts: { cwd: string; exists: (p: string) => boolean; home?: string; isAbsolute: (p: string) => boolean },
): { path: string; fixed: boolean } {
  const lit = opts.isAbsolute(raw) ? raw : joinPath(opts.cwd, raw)
  if (opts.exists(lit)) return { path: lit, fixed: false }
  const found = new Set<string>()
  for (const c of pathCandidates(raw, opts.cwd, opts.home)) {
    const full = opts.isAbsolute(c) ? c : joinPath(opts.cwd, c)
    if (opts.exists(full)) found.add(full)
  }
  if (found.size === 1) return { path: [...found][0]!, fixed: true }
  return { path: lit, fixed: false }
}

function joinPath(a: string, b: string) {
  const sep = a.includes("\\") && !a.includes("/") ? "\\" : "/"
  return a.replace(/[\\/]+$/, "") + sep + b.replace(/^[\\/]+/, "")
}

// ---- oldString recovery -------------------------------------------------------------------------------------

const FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-",
  " ": " ", " ": " ", " ": " ", " ": " ", "​": "",
  "…": "...",
}

/** Fold typographic characters to ASCII. Length-preserving except for the ellipsis and zero-width space. */
export function fold(s: string): string {
  let out = ""
  for (const ch of s) out += FOLD[ch] ?? ch
  return out
}

function foldWithMap(s: string): { text: string; map: number[] } {
  // map[i] = index in the original string of folded char i; map[text.length] = s.length
  let text = ""
  const map: number[] = []
  let i = 0
  for (const ch of s) {
    const f = FOLD[ch] ?? ch
    for (let k = 0; k < f.length; k++) map.push(i)
    text += f
    i += ch.length
  }
  map.push(s.length)
  return { text, map }
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'" }
const decodeEntities = (s: string) => s.replace(/&(?:lt|gt|amp|quot|apos|#39);/g, (m) => ENTITIES[m]!)

function stripFence(s: string): string | undefined {
  const m = /^\s*```[\w+-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(s)
  return m ? m[1] : undefined
}

const LINE_PREFIX = /^\s*\d+(?:→|\t|: | \| |\|)/
/** Remove "  12→" / "12: " prefixes copied from read output, only when EVERY non-empty line has one. */
function stripLineNumbers(s: string): string | undefined {
  const lines = s.split(/\r?\n/)
  const body = lines.filter((l) => l.trim() !== "")
  if (body.length === 0 || !body.every((l) => LINE_PREFIX.test(l))) return undefined
  return lines.map((l) => l.replace(LINE_PREFIX, "")).join("\n")
}

export interface Recovery {
  /** exact text as it appears in the file (use as oldString) */
  span: string
  /** the same transform applied to newString so the replacement keeps the model's intent */
  newString: string
  via: string
}

function occurrences(hay: string, needle: string): number[] {
  const idx: number[] = []
  if (!needle) return idx
  let from = 0
  for (;;) {
    const i = hay.indexOf(needle, from)
    if (i === -1) return idx
    idx.push(i)
    from = i + needle.length
  }
}

/**
 * Last-resort recovery, used only after the upstream replacer ladder failed. Tries a few transforms of oldString.
 * Accepts a transform only when it yields exactly one span in the file (or `replaceAll` is set and >= 1).
 * Returns undefined when nothing safe is found.
 */
export function recoverOldString(content: string, oldString: string, newString: string, replaceAll = false): Recovery | undefined {
  const ok = (n: number) => (replaceAll ? n >= 1 : n === 1)
  const stages: { via: string; old: string; new: string }[] = []
  const fence = stripFence(oldString)
  if (fence !== undefined) stages.push({ via: "code-fence", old: fence, new: stripFence(newString) ?? newString })
  const ln = stripLineNumbers(oldString)
  if (ln !== undefined) stages.push({ via: "line-numbers", old: ln, new: stripLineNumbers(newString) ?? newString })
  if (/&(?:lt|gt|amp|quot|apos|#39);/.test(oldString) && !/&(?:lt|gt|amp|quot|apos|#39);/.test(content))
    stages.push({ via: "html-entities", old: decodeEntities(oldString), new: decodeEntities(newString) })
  stages.push({ via: "typographic", old: oldString, new: newString })

  const folded = foldWithMap(content)
  for (const st of stages) {
    // exact hit for the transformed text (CRLF-insensitive)
    const eol = content.includes("\r\n") ? "\r\n" : "\n"
    const o = st.old.replace(/\r\n/g, "\n").replaceAll("\n", eol)
    const n = st.new.replace(/\r\n/g, "\n").replaceAll("\n", eol)
    if (st.via !== "typographic") {
      const hits = occurrences(content, o)
      if (ok(hits.length)) return { span: o, newString: n, via: st.via }
    }
    // typographic fold on both sides
    const fo = fold(o)
    if (!fo) continue
    const hits = occurrences(folded.text, fo)
    if (!ok(hits.length)) continue
    // map back; all hits must map to identical original spans only when replaceAll, else single
    const spans = hits.map((h) => content.slice(folded.map[h]!, folded.map[h + fo.length]!))
    const distinct = new Set(spans)
    if (distinct.size !== 1) continue
    const span = spans[0]!
    if (span === "" || content.indexOf(span) === -1) continue
    if (span === o && st.via === "typographic") continue // no change, upstream already failed on it
    return { span, newString: n, via: st.via === "typographic" ? "typographic" : `${st.via}+typographic` }
  }
  return undefined
}
