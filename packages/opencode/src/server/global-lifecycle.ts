import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { Effect } from "effect"
import { Event } from "./event"
import { makeDisposeCoordinator, type Request } from "./dispose-coordinator"

// Migrated TUI settings and schema/layout metadata cannot change the behavior
// of an already-running server instance. Keep this list small; uncertain keys
// must still trigger disposal.
const uiOnlyConfigKeys = new Set(["$schema", "theme", "keybinds", "tui", "layout"])

export const configChangeNeedsDisposal = (changedKeys: readonly string[]) =>
  changedKeys.some((key) => !uiOnlyConfigKeys.has(key))

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

const coordinatedDispose = makeDisposeCoordinator((request) =>
  Effect.gen(function* () {
    yield* Effect.logDebug("disposing all instances", {
      caller: request.callers.join(", "),
      changedKeys: request.changedKeys,
    })
    const store = yield* InstanceStore.Service
    yield* request.swallowErrors
      ? store.disposeAll().pipe(Effect.catchCause((cause) => Effect.logWarning("global disposal failed", { cause })))
      : store.disposeAll()
    yield* emitGlobalDisposed
  }).pipe(Effect.uninterruptible),
)

export const disposeAllInstancesAndEmitGlobalDisposed = (request?: Request) =>
  coordinatedDispose({ ...request, caller: request?.caller ?? "TUI worker exit" }).pipe(
    // A disposal that hangs is abandoned by the coordinator (so later ones are not blocked); callers that opted into
    // swallowErrors only get a warning, everyone else sees a failure.
    Effect.catchTag("DisposeTimeoutError", (error) =>
      request?.swallowErrors
        ? Effect.logWarning("global disposal timed out and was abandoned", { timeoutMs: error.timeoutMs })
        : Effect.die(error),
    ),
  )

export * as GlobalLifecycle from "./global-lifecycle"
