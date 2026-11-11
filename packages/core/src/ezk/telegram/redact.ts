// Ezkielyna Telegram bridge: log redaction. Telegram bot tokens look like 123456789:AA... and are embedded in every API URL,
// so an unhandled fetch error would leak one. Every log line and error message goes through here.
import { redactSecrets } from "../../ezkielyna-redact"

const BOT_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g
const BOT_URL = /(\/bot)[^/\s"']+/g

export function makeRedactor(...secrets: (string | undefined)[]) {
  const exact = secrets.filter((s): s is string => !!s && s.length >= 6)
  return (text: string): string => {
    let out = text
    for (const s of exact) out = out.split(s).join("[redacted]")
    out = out.replace(BOT_URL, "$1[redacted]").replace(BOT_TOKEN, "[redacted-bot-token]")
    return redactSecrets(out)
  }
}

export type Logger = (msg: string) => void

export function makeLogger(redact: (t: string) => string, sink: (line: string) => void = (l) => process.stderr.write(l + "\n")): Logger {
  return (msg) => sink(`[ezk-telegram ${new Date().toISOString()}] ${redact(String(msg))}`)
}
