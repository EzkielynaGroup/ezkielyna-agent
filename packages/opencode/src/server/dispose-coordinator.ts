import { Deferred, Duration, Effect, Exit, Fiber } from "effect"

export interface Request {
  caller?: string
  changedKeys?: readonly string[]
  swallowErrors?: boolean
}

export interface Metadata {
  callers: string[]
  changedKeys: string[]
  swallowErrors: boolean
}

export interface Options {
  /** Quiet window after a disposal before the trailing one may start (default 300 ms). */
  debounceMs?: number
  /** A disposal that has not finished after this long is abandoned so it cannot block later ones (default 30 s). */
  timeoutMs?: number
  /** Upper bound for the quiet window while requests keep arriving (default 2 s). */
  maxWaitMs?: number
}

export class DisposeTimeoutError extends Error {
  readonly _tag = "DisposeTimeoutError"
  constructor(readonly timeoutMs: number) {
    super(`instance disposal did not finish within ${timeoutMs} ms`)
    this.name = "DisposeTimeoutError"
  }
}

type Waiter<E> = Deferred.Deferred<Exit.Exit<void, E | DisposeTimeoutError>>

type Batch<E> = {
  callers: Set<string>
  changedKeys: Set<string>
  swallowErrors: boolean
  waiters: Waiter<E>[]
}

type State<E> = {
  /** A disposal is running, or the quiet window after one is open. */
  busy: boolean
  /** Bumped by every request; the quiet window ends when it stops changing. */
  revision: number
  /** Requests that arrived while busy. They share ONE later disposal that starts after they all arrived. */
  pending?: Batch<E>
}

function batch<E>(request: Request, waiter: Waiter<E>): Batch<E> {
  return {
    callers: new Set([request.caller ?? "unknown"]),
    changedKeys: new Set(request.changedKeys ?? []),
    swallowErrors: request.swallowErrors === true,
    waiters: [waiter],
  }
}

function merge<E>(target: Batch<E>, request: Request, waiter: Waiter<E>) {
  target.callers.add(request.caller ?? "unknown")
  for (const key of request.changedKeys ?? []) target.changedKeys.add(key)
  target.swallowErrors = target.swallowErrors && request.swallowErrors === true
  target.waiters.push(waiter)
}

function metadata<E>(value: Batch<E>): Metadata {
  return {
    callers: [...value.callers].sort(),
    changedKeys: [...value.changedKeys].sort(),
    swallowErrors: value.swallowErrors,
  }
}

/**
 * Coalesces bursts of disposal requests without ever losing one.
 *
 * - An isolated request runs immediately (leading edge) and its caller is released as soon as that run ends: no debounce latency.
 * - Requests that arrive while a disposal runs, or inside the quiet window after it, share one trailing disposal. That disposal starts
 *   after the last of them arrived, and it is detached from the batch before it starts, so a request that arrives while it runs
 *   (or while it is the "trailing" one) gets its OWN later disposal instead of being folded into a run that may already have passed it.
 * - Every disposal has a timeout. A hung one is abandoned (its waiters fail with DisposeTimeoutError) and the next request starts a
 *   fresh run; nothing waits forever.
 * - Callers can be interrupted; the disposals themselves run in detached fibers.
 */
export function makeDisposeCoordinator<R, E = never>(
  run: (input: Metadata) => Effect.Effect<void, E, R>,
  options: Options | number = {},
) {
  const config = typeof options === "number" ? { debounceMs: options } : options
  const debounceMs = config.debounceMs ?? 300
  const timeoutMs = config.timeoutMs ?? 30_000
  const maxWaitMs = config.maxWaitMs ?? 2_000
  let state: State<E> = { busy: false, revision: 0 }

  const runBatch = (value: Batch<E>) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<Exit.Exit<void, E | DisposeTimeoutError>>()
      yield* Effect.forkDetach(
        Effect.exit(run(metadata(value))).pipe(Effect.flatMap((exit) => Deferred.succeed(result, exit))),
      )
      const timer = yield* Effect.forkDetach(
        Effect.sleep(Duration.millis(timeoutMs)).pipe(
          Effect.flatMap(() => Deferred.succeed(result, Exit.fail(new DisposeTimeoutError(timeoutMs)))),
        ),
      )
      const exit = yield* Deferred.await(result)
      // The run itself is never awaited after a timeout: it may be uninterruptible and stuck.
      yield* Fiber.interrupt(timer)
      yield* Effect.forEach(value.waiters, (waiter) => Deferred.succeed(waiter, exit), { discard: true })
    })

  const loop = (first: Batch<E>) =>
    Effect.gen(function* () {
      yield* runBatch(first)
      while (true) {
        // Quiet window: wait until no request arrived for debounceMs (bounded by maxWaitMs so a steady stream cannot starve the trailing run).
        const started = Date.now()
        let seen = state.revision
        yield* Effect.sleep(Duration.millis(debounceMs))
        while (state.revision !== seen && Date.now() - started < maxWaitMs) {
          seen = state.revision
          yield* Effect.sleep(Duration.millis(debounceMs))
        }
        const next = yield* Effect.sync(() => {
          const value = state.pending
          state.pending = undefined
          if (!value) state.busy = false
          return value
        })
        if (!next) return
        yield* runBatch(next)
      }
    })

  return (request: Request = {}) =>
    Effect.gen(function* () {
      const waiter = yield* Deferred.make<Exit.Exit<void, E | DisposeTimeoutError>>()
      const leading = yield* Effect.sync(() => {
        state.revision++
        if (!state.busy) {
          state.busy = true
          return batch(request, waiter)
        }
        if (state.pending) merge(state.pending, request, waiter)
        else state.pending = batch(request, waiter)
        return undefined
      })
      if (leading) yield* Effect.forkDetach(loop(leading))
      const exit = yield* Deferred.await(waiter)
      if (Exit.isSuccess(exit)) return
      return yield* Effect.failCause(exit.cause)
    })
}
