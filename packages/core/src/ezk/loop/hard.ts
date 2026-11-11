export const HARD_ATTEMPTS = 3
const GIB = 1024 ** 3

export interface HardCandidate {
  attempt: number
  verified: boolean
  diff: string
  costUSD: number
}

/** Keep attempts sequential unless the machine has comfortably more than the supported 8 GB class. */
export function hardAttemptConcurrency(totalMemoryBytes: number) {
  return Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 16 * GIB ? HARD_ATTEMPTS : 1
}

/** Divide only the remaining task budget among the attempts still to start. */
export function hardAttemptBudget(totalBudgetUSD: number, spentUSD: number, attemptsRemaining: number) {
  if (![totalBudgetUSD, spentUSD, attemptsRemaining].every(Number.isFinite) || attemptsRemaining <= 0) return 0
  return Math.max(0, totalBudgetUSD - Math.max(0, spentUSD)) / attemptsRemaining
}

/**
 * Normalize changed diff lines for duplicate detection. Paths and add/delete direction remain significant; whitespace
 * outside strings and source comments are ignored. This is a conservative fingerprint, not a semantic equivalence test.
 */
export function normalizeHardDiff(diff: string) {
  const normalized: string[] = []
  let file = ""
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const paths = /^diff --git ("?a\/.+?"?) ("?b\/.+?"?)$/.exec(line)
      if (paths) {
        file = paths[2]!.replace(/^"?b\//, "").replace(/"$/, "")
        normalized.push(`file:${file}`)
      }
      continue
    }
    if (/^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to) /.test(line)) {
      normalized.push(`meta:${line.trim()}`)
      continue
    }
    if ((line.startsWith("--- a/") || line.startsWith('--- "a/')) && !file) {
      file = line.startsWith('--- "a/') ? line.slice(7, -1) : line.slice(6)
      normalized.push(`file:${file}`)
      continue
    }
    if ((line.startsWith("+++ b/") || line.startsWith('+++ "b/')) && !file) {
      file = line.startsWith('+++ "b/') ? line.slice(7, -1) : line.slice(6)
      normalized.push(`file:${file}`)
      continue
    }
    if (!/^[+-]/.test(line) || line.startsWith("+++") || line.startsWith("---")) continue
    const sign = line[0]!
    const code = normalizeCodeLine(line.slice(1), file)
    if (code) normalized.push(`${sign}${code}`)
  }
  return normalized.join("\n")
}

/** Filter failed/empty results, dedupe normalized diffs, then return only the smallest verified candidates. */
export function hardModeFinalists(candidates: HardCandidate[]) {
  const unique = new Map<string, HardCandidate>()
  for (const candidate of candidates) {
    if (!candidate.verified || !candidate.diff.trim()) continue
    const key = normalizeHardDiff(candidate.diff)
    if (!key) continue
    const previous = unique.get(key)
    if (!previous || candidate.costUSD < previous.costUSD || (candidate.costUSD === previous.costUSD && candidate.attempt < previous.attempt)) {
      unique.set(key, candidate)
    }
  }
  const valid = [...unique.values()]
  if (!valid.length) return []
  const smallest = Math.min(...valid.map((candidate) => Buffer.byteLength(candidate.diff, "utf8")))
  return valid
    .filter((candidate) => Buffer.byteLength(candidate.diff, "utf8") === smallest)
    .toSorted((a, b) => a.attempt - b.attempt)
}

function normalizeCodeLine(input: string, file: string) {
  const hashComments = /\.(?:py|pyi|sh|bash|zsh|yml|yaml|toml|ini|conf)$/i.test(file)
  const preserveIndent = /\.(?:py|pyi|yml|yaml)$/i.test(file)
  const indentation = preserveIndent ? /^[ \t]*/.exec(input)?.[0] ?? "" : ""
  let out = indentation
  let quote = ""
  let escaped = false
  let pendingSpace = false
  for (let i = indentation.length; i < input.length; i++) {
    const char = input[i]!
    const next = input[i + 1]
    if (quote) {
      out += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      continue
    }
    if (/\s/.test(char)) {
      pendingSpace = true
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      if (needsSpace(out.at(-1), char, pendingSpace)) out += " "
      quote = char
      out += char
      pendingSpace = false
      continue
    }
    if ((char === "/" && next === "/") || (char === "/" && next === "*")) break
    if (hashComments && char === "#") break
    if (needsSpace(out.at(-1), char, pendingSpace)) out += " "
    out += char
    pendingSpace = false
  }
  return out
}

function needsSpace(previous: string | undefined, next: string, pendingSpace: boolean) {
  if (!pendingSpace || !previous) return false
  if (/[A-Za-z0-9_$]/.test(previous) && /[A-Za-z0-9_$]/.test(next)) return true
  return /[+\-*/%=&|^!<>?:.]/.test(previous) && /[+\-*/%=&|^!<>?:.]/.test(next)
}
