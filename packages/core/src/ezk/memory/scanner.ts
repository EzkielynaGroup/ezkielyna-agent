// Ezkielyna Agent v1.1: gatekeeper for everything that may be written to memory (tool calls AND the reviewer).
// Memory is replayed into future prompts, so it must never hold secrets and must not carry prompt-injection payloads.
// Pure function; conservative on purpose (a false positive only means "not saved").

export type ScanResult = { ok: true } | { ok: false; reason: string }

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, "API key (sk-...)"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}/, "Telegram bot token"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, "bearer token"],
  [/\b(?:password|passwd|pwd|passphrase|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|private[_ -]?key|kata sandi|sandi)\b\s*(?:is|=|:|adalah)\s*\S{4,}/i, "credential assignment"],
  [/[?&](?:key|token|api_key|apikey|secret|password|access_token)=[^&\s]{6,}/i, "secret in URL"],
  [/\b(?:seed phrase|recovery phrase|mnemonic|frasa pemulihan)\b/i, "seed phrase"],
  [/\b(?:0x[a-fA-F0-9]{64})\b/, "wallet private key"],
]

const THREAT_PATTERNS: [RegExp, string][] = [
  [/\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|these)\b[^.\n]{0,30}\b(?:instruction|rule|prompt|polic|guideline)/i, "prompt-injection phrase"],
  [/\b(?:you are now|from now on you|act as if|pretend (?:to be|you))\b/i, "role override phrase"],
  [/\b(?:system prompt|developer message)\b/i, "references the system prompt"],
  [/\b(?:curl|wget|nc|ncat)\b[^\n]{0,80}https?:\/\//i, "network exfiltration command"],
  [/\b(?:send|post|upload|exfiltrate|forward)\b[^.\n]{0,50}\b(?:to|at)\b[^.\n]{0,20}https?:\/\//i, "exfiltration instruction"],
  [/[​-‏‪-‮⁠-⁤﻿]/, "invisible unicode"],
]

function luhn(digits: string) {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

function entropy(s: string) {
  const freq = new Map<string, number>()
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

export function scanForSecrets(text: string): ScanResult {
  for (const [re, reason] of SECRET_PATTERNS) if (re.test(text)) return { ok: false, reason: `looks like a secret: ${reason}` }
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/[ -]/g, "")
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return { ok: false, reason: "looks like a secret: card number" }
  }
  for (const token of text.split(/\s+/)) {
    const t = token.replace(/^[("'`[{]+|[)"'`\]},.;:]+$/g, "")
    if (t.length < 28 || t.includes("://") || t.startsWith("/") || t.startsWith("~")) continue
    if (!/^[A-Za-z0-9+/_=.-]+$/.test(t)) continue
    const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(t)).length
    if (classes >= 2 && entropy(t) > 3.7) return { ok: false, reason: "looks like a secret: long random token" }
  }
  return { ok: true }
}

export function scanForThreats(text: string): ScanResult {
  for (const [re, reason] of THREAT_PATTERNS) if (re.test(text)) return { ok: false, reason: `not saved: ${reason}` }
  return { ok: true }
}

/** Everything a memory write must pass. */
export function scanMemoryText(text: string): ScanResult {
  const secret = scanForSecrets(text)
  if (!secret.ok) return secret
  return scanForThreats(text)
}
