// Ezkielyna Agent v1.1: routed fetch. Wraps the HTTP call to the gateway so that, for turns the router owns:
//   - a failed request (403/404/503/timeout/...) is retried ONCE on the next healthy model of the chain, immediately
//     (no multi-second SessionRetry backoff), the circuit breaker learns from it, and the switch is reported;
//   - the first response byte must arrive within `firstByteMs` (default 25 s) or the model counts as timed out.
// Requests that are not routed (user pinned a model / alias) pass through untouched, but still feed the breaker.
// The wrapper only touches POST {baseURL}/chat/completions with a JSON string body; the x-ezk-* headers are internal
// and are stripped before anything leaves the machine.
import { isHardStatus } from "./breaker"
import type { RouterEngine } from "./engine"

export const H_SESSION = "x-ezk-session"
export const H_MESSAGE = "x-ezk-message"

export interface SwitchEvent {
  sessionID: string
  messageID?: string
  from: string
  to: string
  status: number
  reason: string
}

export interface RoutedFetchOptions {
  engine: RouterEngine
  baseURL: string
  base?: typeof fetch
  firstByteMs?: number
  onSwitch?: (e: SwitchEvent) => void
}

const NO_ACCESS = /no available channel|model[_ -]?not[_ -]?found|not have access|无可用渠道|does not exist|unsupported model/i

/** Map a failed response to the status the breaker should see (a 503 "no channel for model" is a closed model). */
export function failureStatus(status: number, body: string): number | undefined {
  if (status >= 200 && status < 300) return undefined
  if (isHardStatus(status)) return status
  if (status === 400 && NO_ACCESS.test(body)) return 404
  if (status === 503 && NO_ACCESS.test(body)) return 404
  if (status === 429 || status >= 500) return status
  return undefined
}

function describe(status: number) {
  return status === 0 ? "timeout" : `HTTP ${status}`
}

export function routedFetch(opts: RoutedFetchOptions): typeof fetch {
  const base = opts.base ?? fetch
  const target = `${opts.baseURL.replace(/\/+$/, "")}/chat/completions`
  const firstByteMs = opts.firstByteMs ?? 25_000

  const attempt = async (input: any, init: RequestInit, timed: boolean) => {
    if (!timed) return base(input, init)
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(new Error("ezk first-byte timeout")), firstByteMs)
    const signal = init.signal ? AbortSignal.any([init.signal, ctl.signal]) : ctl.signal
    try {
      return await base(input, { ...init, signal })
    } finally {
      clearTimeout(timer)
    }
  }

  const wrapped = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url as string | undefined)
    if (!url || !url.startsWith(target) || !init || typeof init.body !== "string") return base(input, init)

    const headers = new Headers(init.headers)
    const sessionID = headers.get(H_SESSION) ?? undefined
    const messageID = headers.get(H_MESSAGE) ?? undefined
    headers.delete(H_SESSION)
    headers.delete(H_MESSAGE)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(init.body)
    } catch {
      return base(input, { ...init, headers })
    }
    const model = typeof body.model === "string" ? body.model : undefined
    if (!model) return base(input, { ...init, headers })

    const routed = !!sessionID
    const send = async (m: string) => {
      const next: RequestInit = { ...init, headers, body: m === body.model ? init.body : JSON.stringify({ ...body, model: m }) }
      try {
        const res = await attempt(input, next, routed)
        if (res.ok) return { res, status: undefined as number | undefined }
        const text = await res.clone().text().catch(() => "")
        return { res, status: failureStatus(res.status, text) }
      } catch (err) {
        if (init.signal?.aborted) throw err
        return { res: undefined, status: 0, err }
      }
    }

    // A retry of an earlier request may still name a model that has since been marked unavailable: skip straight to
    // the next healthy one instead of knocking on a closed door.
    if (routed && opts.engine.breaker.isOpen(model)) {
      const alt = opts.engine.next(sessionID!, model)
      if (alt) {
        opts.engine.noteSwitch(sessionID!, model, alt)
        opts.onSwitch?.({ sessionID: sessionID!, messageID, from: model, to: alt, status: -1, reason: `${model} unavailable (circuit open)` })
        const res = await send(alt)
        if (res.status === undefined) opts.engine.breaker.success(alt)
        else opts.engine.breaker.failure(alt, res.status)
        if (res.res) return res.res
        throw res.err
      }
    }
    const first = await send(model)
    if (first.status === undefined) {
      opts.engine.breaker.success(model)
      return first.res!
    }
    opts.engine.breaker.failure(model, first.status)
    const fallback = routed ? opts.engine.next(sessionID!, model) : undefined
    if (!fallback) {
      if (first.res) return first.res
      throw first.err
    }
    const reason = `${model} failed (${describe(first.status)})`
    opts.engine.noteSwitch(sessionID!, model, fallback)
    opts.onSwitch?.({ sessionID: sessionID!, messageID, from: model, to: fallback, status: first.status, reason })
    // Drain the failed response so the connection is released.
    void first.res?.body?.cancel().catch(() => {})
    const second = await send(fallback)
    if (second.status === undefined) opts.engine.breaker.success(fallback)
    else opts.engine.breaker.failure(fallback, second.status)
    if (second.res) return second.res
    throw second.err
  }) as typeof fetch
  return wrapped
}
