// Ezkielyna Agent: redaction for the beta bug report (`ezkielyna lapor`, /lapor, the desktop dialog).
//
// The report is shared by hand (WhatsApp group, e-mail), so a miss leaks a secret to other people and a false positive only blurs a
// log line. Three layers, applied to every untrusted fragment (log lines, error text, config values):
//   1. normalize   undo JSON/logfmt escaping (`\"`, `\\`, `\uXXXX`) and the percent-escapes of `= & ? / \ :`, so the rules below see
//                  the text the way a human would read it. The log writer JSON-stringifies values, so a Windows path is stored as
//                  `C:\\Users\\name` and a JSON body as `{\"apiKey\":\"...\"}`.
//   2. structure   home folders and the account name, `Authorization` of any scheme, cookies, URL user info, URL query secrets,
//                  and (strict mode) the VALUE of every `key=value` / `"key":"value"` pair whose key name looks sensitive.
//   3. shapes      well-known key formats (sk-, ezk-, ghp_, github_pat_, AIza, AKIA, xox, JWT, ...), e-mail addresses.
// Fixed report labels are never passed through the strict key/value rule (it would blur "API key: present"), only through 1 and 3.

export type RedactOptions = {
  /** The user's home folder (os.homedir()). Every spelling of it becomes `~`. */
  homeDir?: string
  /** More home folder spellings (USERPROFILE, HOME, HOMEDRIVE+HOMEPATH). */
  homeDirs?: readonly string[]
  /** Account name (os.userInfo().username); replaced as a whole word. */
  userName?: string
  /** Redact the value of any key=value pair whose key looks sensitive. Use for free-form text (logs, error messages). */
  strict?: boolean
}

const REDACTED = "[REDACTED]"

// --- 1. normalize ---------------------------------------------------------------------------------------------------------

const PERCENT: Record<string, string> = { "3d": "=", "26": "&", "3f": "?", "2f": "/", "5c": "\\", "3a": ":", "22": '"', "27": "'" }

export function normalizeForRedaction(text: string) {
  let out = text
  // Up to three rounds: a value escaped twice (JSON inside a quoted logfmt value) needs two.
  for (let round = 0; round < 3; round++) {
    const next = out
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\\\/g, "\\")
      .replace(/\\(["'/])/g, "$1")
      // %40 is left alone on purpose: `user:p%40ss@host` must still read as user info.
      .replace(/%(3[Dd]|26|3[Ff]|2[Ff]|5[Cc]|3[Aa]|22|27)/g, (_, code: string) => PERCENT[code.toLowerCase()] ?? _)
    if (next === out) break
    out = next
  }
  return out
}

// --- 2a. paths and account name ---------------------------------------------------------------------------------------------

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function homeVariants(home: string) {
  const forward = home.replaceAll("\\", "/")
  const back = home.replaceAll("/", "\\")
  const variants = new Set([home, forward, back, back.replaceAll("\\", "\\\\"), encodeURIComponent(home), encodeURI(forward)])
  // Git Bash (/c/Users/name) and WSL (/mnt/c/Users/name) spell a Windows home differently.
  const drive = /^([A-Za-z]):[\\/]+(.*)$/.exec(home)
  if (drive) {
    const rest = drive[2]!.replaceAll("\\", "/")
    variants.add(`/${drive[1]!.toLowerCase()}/${rest}`)
    variants.add(`/mnt/${drive[1]!.toLowerCase()}/${rest}`)
  }
  return [...variants].filter((value) => value.length >= 4 && !/^[\\/]+$/.test(value))
}

const SEP = String.raw`[\\/]+`
const NAME = String.raw`[^\\/\s"'<>|*?:%]+`
// C:\Users\name, c:/users/name, /Users/name, /c/Users/name, /mnt/c/Users/name. The lookbehind keeps `src/Users/Profile.ts` intact.
const USERS_DIR = new RegExp(String.raw`(?<![\w.~-])(?:[A-Za-z]:|/mnt/[A-Za-z]|/[A-Za-z](?=${SEP}Users${SEP}))?${SEP}Users${SEP}${NAME}`, "gi")
const HOME_DIR = new RegExp(String.raw`(?<![\w.~-])/home/${NAME}`, "g")

function redactPaths(text: string, opts: RedactOptions) {
  let out = text
  const homes = [opts.homeDir, ...(opts.homeDirs ?? [])].filter((value): value is string => Boolean(value))
  const variants = [...new Set(homes.flatMap(homeVariants))].sort((a, b) => b.length - a.length)
  for (const variant of variants) out = out.replace(new RegExp(escapeRegExp(variant), "gi"), "~")
  out = out.replace(USERS_DIR, "~").replace(HOME_DIR, "~")
  const user = opts.userName?.trim()
  if (user && user.length >= 3) out = out.replace(new RegExp(String.raw`(?<![A-Za-z0-9])${escapeRegExp(user)}(?![A-Za-z0-9])`, "gi"), "<user>")
  return out
}

// --- 2b. headers, URLs ------------------------------------------------------------------------------------------------------

// `Authorization: <scheme> <credentials>` for any scheme (Bearer, Basic, Token, ApiKey, ...) or a bare value. Digest-style schemes carry several
// comma separated parameters, so those consume the rest of the line.
const AUTHORIZATION =
  /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*)["']?(?:(?:Digest|NTLM|Negotiate|AWS4-HMAC-SHA256)\s+[^\r\n"']*|(?:[A-Za-z][\w-]*[ \t]+)?[^\s"',;]+)/gi
const COOKIE = /\b((?:set-)?cookie)(["']?\s*[:=]\s*)["']?[^\r\n"']*/gi
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s"'?#]*@/gi
const URL_PARAM = /([?&;])([\w.%[\]-]+)=([^&#\s"'<>]*)/g
const SECRET_QUERY_NAME = /(?:^|[._-])(?:code|sig|signature|state)$|^x-amz-|^x-goog-/i

// --- 2c. key=value pairs ----------------------------------------------------------------------------------------------------

const STRONG_KEY = /secret|token|passw|credential|api[-_]?key|apikey|authorization|cookie|bearer|jwt|private[-_]?key|signature|pwd/i
const WEAK_KEY = /pass|key|auth|session|sig/i
const BENIGN_KEY = /keybind|keyboard|signal|design|assign|author(?!iz)|bypass|compass|passed|passes|passing|passthrough|session[._-]?id|key[._-]?present|monkey/i

export function isSensitiveKey(name: string) {
  if (STRONG_KEY.test(name)) return true
  if (BENIGN_KEY.test(name)) return false
  return WEAK_KEY.test(name)
}

const KV_PREFIX = /(?<![\w.-])(["']?)([A-Za-z_][\w.-]{0,80})\1(\s*[:=]\s*)(["']?)/g

function redactPairs(text: string) {
  let out = ""
  let last = 0
  KV_PREFIX.lastIndex = 0
  for (let match = KV_PREFIX.exec(text); match; match = KV_PREFIX.exec(text)) {
    const [whole, , name, , quote] = match
    const valueStart = match.index + whole.length
    if (!isSensitiveKey(name!)) continue
    let end: number
    if (quote) {
      const close = text.indexOf(quote, valueStart)
      const eol = text.slice(valueStart).search(/[\r\n]/)
      end = close === -1 ? (eol === -1 ? text.length : valueStart + eol) : close
    } else {
      const stop = text.slice(valueStart).search(/[\s"',;&}\])]/)
      end = stop === -1 ? text.length : valueStart + stop
    }
    if (end <= valueStart) continue
    out += text.slice(last, valueStart) + REDACTED
    last = end
    KV_PREFIX.lastIndex = end
  }
  return out + text.slice(last)
}

// FOO_PASSWORD=..., AWS_SECRET_ACCESS_KEY=..., GITHUB_TOKEN="..."
const ENV_ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|PASSPHRASE|TOKEN|SECRET|KEY|CREDENTIALS?|AUTH|COOKIE)S?=)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/g

// --- 3. key shapes and e-mail -------------------------------------------------------------------------------------------------

const SHAPES: RegExp[] = [
  // Real keys always mix digits or capitals into the random part; `disk-usage-info` and `ezk-router` are not keys.
  /(?:sk|SK)-(?=[A-Za-z0-9._~+/-]*[0-9A-Z])[A-Za-z0-9][A-Za-z0-9._~+/-]{7,}/g,
  /(?:ezk|EZK)-(?=[A-Za-z0-9._~+/-]*[0-9A-Z])[A-Za-z0-9][A-Za-z0-9._~+/-]{11,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\b[pr]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bBearer\s+[^\s,;"']+/gi,
  /\bBasic\s+[A-Za-z0-9+/=_-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bA[KS]IA[0-9A-Z]{16}\b/g,
  /\bxox[abprsoe]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\bbot\d{6,12}:[A-Za-z0-9_-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]
// A key broken over two lines (`sk-A1b2C\n3d4E5...` after logfmt escaping) leaves a short prefix and a long tail.
const SPLIT_KEY = /(?:sk|SK|ezk|EZK)-(?=[A-Za-z0-9._~+/-]{1,7}(?:\\[nrt]|\r?\n))[A-Za-z0-9._~+/-]*[0-9A-Z][A-Za-z0-9._~+/-]*(?:\\[nrt]|\r?\n)+[A-Za-z0-9._~+/-]{8,}/g
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu

export function redactText(text: string, opts: RedactOptions = {}) {
  let out = normalizeForRedaction(text)
  out = redactPaths(out, opts)
  out = out
    .replace(AUTHORIZATION, `$1$2${REDACTED}`)
    .replace(COOKIE, `$1$2${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_PARAM, (all, lead: string, name: string) =>
      isSensitiveKey(name) || SECRET_QUERY_NAME.test(name) ? `${lead}${name}=${REDACTED}` : all,
    )
  if (opts.strict) out = redactPairs(out)
  out = out.replace(ENV_ASSIGNMENT, `$1${REDACTED}`).replace(SPLIT_KEY, REDACTED)
  for (const shape of SHAPES) out = out.replace(shape, REDACTED)
  return out.replace(EMAIL, "[REDACTED_EMAIL]")
}

// --- log lines: what is allowed to reach the report ---------------------------------------------------------------------

export const LOG_LINE_LIMIT = 300
const VALUE_LIMIT = 160

// Keys (last path segment) that carry request/response bodies or prompt text.
const BODY_KEY =
  /^(?:body|requestbody\w*|responsebody\w*|prompt|system|messages|content|input|output|headers?|payload|text|args|env|environment|data|instructions|tools|attachments|stdin|stdout|stderr)$/i
// Body text embedded in an error string (`AI_APICallError ... requestBodyValues: {"messages": ...}`).
const BODY_MARKER =
  /requestBodyValues|responseBody|\b(?:request|response)[ _-]?body\b|"?\b(?:prompt|messages|content|instructions|system)\b"?\s*[:=]\s*[[{"]/i
const TRAILING_SYNTAX = /[\s{[\\"':,]+$/
const LOGFMT_PAIR = /(^|\s)([A-Za-z_][\w.[\]-]*)=("(?:[^"\\]|\\.)*"|\S*)/g

function unquote(raw: string) {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw) as string
    } catch {
      return raw.slice(1, -1)
    }
  }
  return raw
}

const cut = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, limit)}…` : value)

/**
 * Keep the level, message and identifiers of a log line; drop bodies, prompts and headers, and bound every value. This runs BEFORE
 * redaction so a dropped body can never leak through a pattern miss.
 */
export function sanitizeLogLine(line: string) {
  let paired = false
  const cleaned = line.replace(LOGFMT_PAIR, (_all, lead: string, key: string, raw: string) => {
    paired = true
    const last = key.split(".").pop() ?? key
    if (BODY_KEY.test(last)) return `${lead}${key}=[omitted]`
    let value = unquote(raw)
    const marker = BODY_MARKER.exec(value)
    if (marker) value = `${value.slice(0, marker.index).replace(TRAILING_SYNTAX, "")} [body omitted]`
    value = cut(value, VALUE_LIMIT)
    return `${lead}${key}=${/^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)}`
  })
  // Plain text (not key=value pairs): everything from the first body marker on is dropped.
  const marker = paired ? null : BODY_MARKER.exec(cleaned)
  return marker ? `${cleaned.slice(0, marker.index).replace(TRAILING_SYNTAX, "")} [body omitted]` : cleaned
}

/** One physical line, at most LOG_LINE_LIMIT characters. Applied AFTER redaction so truncation can never expose half a secret. */
export function capLine(line: string, limit = LOG_LINE_LIMIT) {
  const flat = line.replace(/\s+/g, " ").trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}
