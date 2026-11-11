// Ezkielyna Agent: process-level guards for the Electron main process.
//
// 1. stdout/stderr can be closed under us (launched from a terminal or agent that exited): a write then raises EPIPE
//    asynchronously on the stream, which used to surface as Electron's blocking "A JavaScript error occurred in the main
//    process" dialog. Stream errors are now swallowed (there is nowhere to report them anyway) and logging to the console
//    is switched off.
// 2. uncaughtException / unhandledRejection are logged to the (redacted) file log and shown as a friendly, non-blocking
//    notification. Only errors during startup, before the first window has loaded, stay fatal.
import { redactSecrets } from "../../../core/src/ezkielyna-redact"

type Streamish = { on(event: "error", listener: (error: unknown) => void): unknown }

const benign = (error: unknown) => {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : ""
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "EIO" || code === "ECONNRESET"
}

const pipeBrokenListeners = new Set<() => void>()
/** Called once when stdout/stderr turn out to be closed (used to switch the console log transport off). */
export const onPipeBroken = (fn: () => void) => void pipeBrokenListeners.add(fn)

export function installStreamGuards(streams: Streamish[] = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    stream.on("error", (error) => {
      if (benign(error)) pipeBrokenListeners.forEach((fn) => fn())
      // not rethrown, whatever the error: a closed log pipe must never take the app down
    })
  }
}

export type ErrorSink = {
  log: (message: string, extra?: Record<string, unknown>) => void
  notify: (title: string, body: string) => void
  /** true until the first window has finished loading; errors before that are fatal. */
  starting: () => boolean
  fatal: (message: string) => void
  now?: () => number
}

export function friendlyMessage(error: unknown, lang = process.env.EZK_LANG || process.env.LANG || "") {
  const id = /^id/i.test(lang)
  const detail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 160)
  return {
    title: id ? "Terjadi kesalahan" : "Something went wrong",
    body: id ? `Ezkielyna Agent mengalami kesalahan tak terduga dan tetap berjalan. Detail: ${detail}` : `Ezkielyna Agent hit an unexpected error and is still running. Details: ${detail}`,
  }
}

export function installErrorHandlers(sink: ErrorSink) {
  let lastShown = 0
  const handle = (kind: string) => (error: unknown) => {
    if (benign(error)) return
    sink.log(kind, { error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
    const message = friendlyMessage(error)
    if (sink.starting()) return sink.fatal(`${message.title}: ${message.body}`)
    const now = (sink.now ?? Date.now)()
    if (now - lastShown < 30_000) return
    lastShown = now
    sink.notify(message.title, message.body)
  }
  process.on("uncaughtException", handle("uncaught exception"))
  process.on("unhandledRejection", handle("unhandled rejection"))
}

installStreamGuards()
