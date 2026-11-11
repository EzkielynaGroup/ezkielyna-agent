import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { isRecord } from "@/util/record"
import { Global } from "@opencode-ai/core/global"
import { loadFlags } from "@opencode-ai/core/ezk/flags"

export type Err = ReturnType<NamedError["toObject"]>

export const QUOTA_MESSAGE =
  "Saldo atau kuota habis. Isi saldo di ezkielyna.store. / Balance or quota used up. Top up at ezkielyna.store."
const BRAND_HYGIENE_ENABLED = loadFlags([Global.Path.config]).brand.hygiene
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5
export const RESILIENCE_RETRY_INITIAL_DELAY = 200
export const RESILIENCE_RETRY_MAX_DELAY = 30_000

// Cut model stream (netcut brief research-v3/SDK-ezk9-netcut.md): the ezk.8 CLI took ~68 s to give up because a reset
// connection went through the generic policy (1 + 5 retries, 2+4+8+16+30 s of back-off, plus a re-run of every tool
// call that had already completed in the cut stream). A cut stream cannot be resumed, so for the Ezkielyna provider:
//  - nothing received yet: at most STREAM_CUT_MAX_RETRIES retries with STREAM_CUT_DELAYS (total <= 10 s);
//  - output already received: no retry, keep the partial turn and show the friendly error at once.
export const STREAM_CUT_MAX_RETRIES = 2
export const STREAM_CUT_DELAYS = [1000, 2000] as const // ms, total 3 s

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

/** A transport-level reset/abort with no HTTP status (what a stream cut looks like), as opposed to a 5xx or 429. */
export function isStreamCut(error: Err) {
  if (SessionV1.APIError.isInstance(error)) {
    if (error.data.statusCode !== undefined) return false
    if (error.data.metadata?.code === "ECONNRESET") return true
    return /connection reset|socket connection was closed|socket hang up|^terminated$|econnreset/i.test(error.data.message)
  }
  const message = isRecord(error.data) ? error.data.message : undefined
  return typeof message === "string" && /connection reset|socket connection was closed|socket hang up|^terminated$|econnreset/i.test(message)
}

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(exponential(attempt, random))
    }
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

/** Opt-in Wave A backoff: short start, bounded server hints, and a hard 30 s ceiling. */
export function resilienceDelay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  const headers = error?.data.responseHeaders
  const retryAfterMs = headers?.["retry-after-ms"]
  if (retryAfterMs !== undefined) {
    const parsed = Number.parseFloat(retryAfterMs)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(Math.ceil(parsed), RESILIENCE_RETRY_MAX_DELAY)
  }
  const retryAfter = headers?.["retry-after"]
  if (retryAfter !== undefined) {
    const seconds = Number.parseFloat(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), RESILIENCE_RETRY_MAX_DELAY)
    const date = Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(date) && date > 0) return Math.min(Math.ceil(date), RESILIENCE_RETRY_MAX_DELAY)
  }
  const base = RESILIENCE_RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, Math.max(0, attempt - 1))
  return Math.min(Math.ceil(base + base * RETRY_JITTER_FACTOR * random), RESILIENCE_RETRY_MAX_DELAY)
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

export function retryable(error: Err, provider: string, opts: { resilience?: boolean; routerManaged?: boolean } = {}) {
  if (opts.resilience) return resilienceRetryable(error, opts.routerManaged ?? false)
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // Ezkielyna Agent: "model not available for this key" comes back as a 503 but retrying can never fix it.
    if (error.data.responseBody?.includes("model_not_found")) return undefined
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      if (!BRAND_HYGIENE_ENABLED) return { message: error.data.message }
      return {
        message: QUOTA_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Saldo atau kuota habis / Balance or quota used up",
          message: QUOTA_MESSAGE,
          label: "Top up",
          link: "https://ezkielyna.store",
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      if (!BRAND_HYGIENE_ENABLED) return { message: error.data.message }
      return {
        message: QUOTA_MESSAGE,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Saldo atau kuota habis / Balance or quota used up",
          message: QUOTA_MESSAGE,
          label: "Top up",
          link: "https://ezkielyna.store",
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

function resilienceRetryable(error: Err, routerManaged: boolean): Retryable | undefined {
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  const api = SessionV1.APIError.isInstance(error) ? error : undefined
  const status = api?.data.statusCode
  // The routed fetch already performs its one breaker-aware fallback for HTTP/network failures.
  // A stream idle error has no HTTP status and remains eligible for the session retry.
  if (routerManaged && api && (status === 0 || status === 429 || (status !== undefined && status >= 500))) return undefined
  const message = api?.data.message ?? (isRecord(error.data) && typeof error.data.message === "string" ? error.data.message : "")
  const body = api?.data.responseBody ?? ""
  const combined = `${message}\n${body}\n${error.name ?? ""}`
  if (/quota|balance|billing|insufficient (?:credit|funds)|usage limit|context(?: length| window)? (?:exceeded|overflow)|maximum context/i.test(combined)) {
    return undefined
  }
  const retryableStatus = status === 429 || (status !== undefined && status >= 500 && status <= 599)
  const retryableNetwork = /fetch failed|failed to fetch|terminated|network[-_\s]error|connection (?:reset|refused|lost)|socket hang up|econn(?:reset|refused)|etimedout|enotfound|eai_again|stream timed out|request timed out|no response from the model|stream idle timeout/i.test(combined)
  if (!retryableStatus && !retryableNetwork) return undefined
  return { message: message || "Temporary network or stream interruption" }
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  resilience?: boolean
  routerManaged?: boolean
  /** Ezkielyna-only cut-stream policy: set for the Ezkielyna provider; `received()` tells whether this attempt streamed anything. */
  streamCut?: { received: () => boolean }
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider, { resilience: opts.resilience, routerManaged: opts.routerManaged })
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > RETRY_MAX_RETRIES) return Cause.done(meta.attempt)
      const cut = opts.streamCut && isStreamCut(error)
      if (cut && (opts.streamCut!.received() || meta.attempt > STREAM_CUT_MAX_RETRIES)) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const apiError = SessionV1.APIError.isInstance(error) ? error : undefined
        const wait = cut
          ? STREAM_CUT_DELAYS[Math.min(meta.attempt, STREAM_CUT_DELAYS.length) - 1]
          : opts.resilience ? resilienceDelay(meta.attempt, apiError) : delay(meta.attempt, apiError)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
