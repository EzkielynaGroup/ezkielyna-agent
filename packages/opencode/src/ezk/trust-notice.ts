// Ezkielyna Agent: the one sentence `run` and `exec` print when a permission mode was requested in a folder the user has not
// trusted. Untrusted folders always ask (core/src/ezk/safety/modes.ts effectiveMode), so a headless run would auto-reject
// every request; saying so up front beats a silent "denied" later. Pure functions, unit-tested.
import { detectLang, type Lang } from "@opencode-ai/core/ezkielyna-errors"
import { parseMode, type Mode } from "@opencode-ai/core/ezk/safety/modes"

/** `ask` is what an untrusted folder gets anyway and `plan` only restricts, so neither is "ignored". */
export function modeIgnoredWhenUntrusted(mode: Mode | undefined, trusted: boolean): boolean {
  return !trusted && mode !== undefined && mode !== "ask" && mode !== "plan"
}

/** The mode a `--permission-mode` value asks for (the same aliases as the flag), or undefined for none/unknown. */
export function requestedMode(value: unknown): Mode | undefined {
  if (typeof value !== "string") return undefined
  if (value.trim().toLowerCase().replace(/[\s_-]/g, "") === "dontask") return "ask"
  return parseMode(value)
}

export function untrustedModeNotice(mode: string, lang: Lang = detectLang()): string {
  return lang === "id"
    ? `Folder ini belum dipercaya, jadi --permission-mode ${mode} diabaikan. Jalankan: ezkielyna trust`
    : `This folder is not trusted, so --permission-mode ${mode} is ignored. Run: ezkielyna trust`
}

/** Prints the notice (callers call this once per process). Returns true when it was printed. */
export function warnUntrustedMode(input: { mode: Mode | undefined; raw?: string; trusted: boolean; log: (text: string) => void; lang?: Lang }): boolean {
  if (!modeIgnoredWhenUntrusted(input.mode, input.trusted)) return false
  input.log(`! ${untrustedModeNotice(input.raw ?? input.mode!, input.lang)}`)
  return true
}

/** The TUI's call: takes the raw `--permission-mode` argument, writes the notice as one line to stderr (or `write`). */
export function warnUntrustedModeFlag(input: { value: unknown; trusted: boolean; write?: (text: string) => void; lang?: Lang }): boolean {
  if (input.value === undefined || input.value === "") return false
  const write = input.write ?? ((text: string) => void process.stderr.write(text))
  return warnUntrustedMode({
    mode: requestedMode(input.value),
    raw: String(input.value),
    trusted: input.trusted,
    log: (text) => write(text + "\n"),
    lang: input.lang,
  })
}
