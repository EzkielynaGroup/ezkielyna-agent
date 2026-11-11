// Ezkielyna Agent: secret redaction for every log writer (server log file/stderr, desktop log, exported zips).
// Patterns are deliberately broad: a false positive costs a blurred log line, a miss leaks a key.
const PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]"],
  [/((?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',}&]{8,}/gi, "$1[redacted]"],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Redacts strings inside arbitrary (JSON-like) values, for log libraries that take objects. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactSecrets(value) as T
  if (depth > 6 || value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1)) as T
  if (value instanceof Error) {
    const copy = new Error(redactSecrets(value.message))
    copy.name = value.name
    copy.stack = value.stack ? redactSecrets(value.stack) : undefined
    return copy as T
  }
  return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, redactDeep(v, depth + 1)])) as T
}
