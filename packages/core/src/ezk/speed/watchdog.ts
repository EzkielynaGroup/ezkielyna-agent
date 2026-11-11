// Ezkielyna Agent v0.9: stream watchdog. Wraps any AsyncIterable of stream events.
//   - no first event within `firstMs` (default 25 s)  -> StreamStalledError("first")
//   - gap between events longer than `idleMs` (default 60 s) -> StreamStalledError("idle")
// On a stall it calls `onStall` (abort the HTTP request) and throws an error whose message matches the existing
// SessionRetry patterns ("stream timed out", "request timed out") so the normal retry / router fallback takes over.
// Idea credit: MiniMax Code (MIT) stream-idle watchdog, re-implemented here.

export class StreamStalledError extends Error {
  readonly kind: "first" | "idle"
  readonly afterMs: number
  constructor(kind: "first" | "idle", afterMs: number) {
    super(
      kind === "first"
        ? `Request timed out: no response from the model within ${Math.round(afterMs / 1000)} s (stream timeout). Retrying.`
        : `Stream timed out: the model went silent for ${Math.round(afterMs / 1000)} s (stream idle timeout). Retrying.`,
    )
    this.name = "StreamStalledError"
    this.kind = kind
    this.afterMs = afterMs
  }
}

export const WATCHDOG_FIRST_MS = 25_000
export const WATCHDOG_IDLE_MS = 60_000

export interface WatchdogOptions {
  firstMs?: number
  idleMs?: number
  /** abort the underlying request */
  onStall?: (e: StreamStalledError) => void
  /** events that arrive before the HTTP response (e.g. the AI SDK "start" part): passed through, but they do not count as the first model event */
  preamble?: (event: any) => boolean
  /** disable (pass-through, zero timers) */
  disabled?: boolean
}

/** Router header (ezk-v2): requests carrying it already have a 25 s first-byte guard + fallback. */
export const ROUTER_GUARD_HEADER = "x-ezk-session"

/** True when the router already guards this request (header present, any case). */
export function routerGuards(headers: Record<string, string | undefined> | undefined): boolean {
  if (!headers) return false
  return Object.keys(headers).some((k) => k.toLowerCase() === ROUTER_GUARD_HEADER && !!headers[k])
}

export async function* watchStream<T>(source: AsyncIterable<T>, opts: WatchdogOptions = {}): AsyncGenerator<T, void, unknown> {
  if (opts.disabled) {
    yield* source
    return
  }
  const firstMs = opts.firstMs ?? WATCHDOG_FIRST_MS
  const idleMs = opts.idleMs ?? WATCHDOG_IDLE_MS
  const it = source[Symbol.asyncIterator]()
  let first = true
  try {
    for (;;) {
      const limit = first ? firstMs : idleMs
      let timer: ReturnType<typeof setTimeout> | undefined
      const stall = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamStalledError(first ? "first" : "idle", limit)), limit)
      })
      let r: IteratorResult<T>
      try {
        r = await Promise.race([it.next(), stall])
      } catch (e) {
        if (e instanceof StreamStalledError) {
          try {
            opts.onStall?.(e)
          } catch {}
          // do not await return(): a hung upstream would never resolve it
          void Promise.resolve(it.return?.()).catch(() => {})
        }
        throw e
      } finally {
        clearTimeout(timer)
      }
      if (r.done) return
      if (!(first && opts.preamble?.(r.value))) first = false
      yield r.value
    }
  } finally {
    // consumer stopped early: release the upstream without blocking
    void Promise.resolve(it.return?.()).catch(() => {})
  }
}
