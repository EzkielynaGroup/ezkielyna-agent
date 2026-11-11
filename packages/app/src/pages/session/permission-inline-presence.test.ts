import { describe, expect, test } from "bun:test"
import { permissionInlineVisible, presenceChange, type PermissionInlinePresence } from "./permission-inline-presence"

// Regression model for the ezk.8 flicker (two permission requests in a row, e.g. `bash` then `external_directory`).
// Each event is what Solid does: the new request's card mounts, then the old card's cleanup runs. The scenario replays
// the same events through a "model" of the shared state and reports whether the inline card and the composer dock were
// ever shown together, or whether the dock toggled while a card for the active request stayed mounted.

type Event =
  | { kind: "mount" | "cleanup" | "visible" | "hidden"; request: string }
  | { kind: "active"; request?: string }

const twoRequestsInARow: Event[] = [
  { kind: "active", request: "A" },
  { kind: "mount", request: "A" },
  { kind: "visible", request: "A" },
  // A is answered: the composer switches to B, B's row mounts, then A's row cleans up (Solid keyed rows).
  { kind: "active", request: "B" },
  { kind: "mount", request: "B" },
  { kind: "visible", request: "B" },
  { kind: "cleanup", request: "A" },
  { kind: "hidden", request: "A" },
]

type Model<S> = {
  initial: S
  step: (state: S, event: Event) => S
  dockHidden: (state: S, active: string | undefined) => boolean
}

function replay<S>(model: Model<S>, events: Event[]) {
  let state = model.initial
  let active: string | undefined
  const mounted = new Set<string>()
  const frames: { card: number; dock: number }[] = []
  for (const event of events) {
    if (event.kind === "active") active = event.request
    if (event.kind === "mount") mounted.add(event.request)
    if (event.kind === "cleanup") mounted.delete(event.request)
    state = model.step(state, event)
    const card = active !== undefined && mounted.has(active) ? 1 : 0
    const dock = active !== undefined && !model.dockHidden(state, active) ? 1 : 0
    frames.push({ card, dock })
  }
  return frames
}

// The ezk.8 model: one boolean set from the card's IntersectionObserver, cleared by whichever card goes away.
const legacyVisibility: Model<boolean> = {
  initial: false,
  step: (state, event) => {
    if (event.kind === "visible") return true
    if (event.kind === "hidden" || event.kind === "cleanup") return false
    return state
  },
  dockHidden: (state) => state,
}

// The fix: presence keyed by request id.
const presenceByID: Model<PermissionInlinePresence> = {
  initial: undefined,
  step: (state, event) => {
    if (event.kind === "mount") return presenceChange(state, event.request, true)
    if (event.kind === "cleanup") return presenceChange(state, event.request, false)
    return state
  },
  dockHidden: (state, active) => permissionInlineVisible(state, active),
}

describe("permission inline presence", () => {
  test("ezk.8 model: the second request shows the card and the dock together (the bug)", () => {
    const frames = replay(legacyVisibility, twoRequestsInARow)
    expect(frames.some((f) => f.card === 1 && f.dock === 1)).toBe(true)
  })

  test("presence by id: exactly one permission prompt in every frame", () => {
    const frames = replay(presenceByID, twoRequestsInARow)
    for (const f of frames) expect(f.card + f.dock).toBe(1)
  })

  test("cleanup of an older card never clears a newer card's presence", () => {
    let state: PermissionInlinePresence = presenceChange(undefined, "A", true)
    state = presenceChange(state, "B", true)
    state = presenceChange(state, "A", false)
    expect(state).toBe("B")
  })

  test("cleanup of the current card clears it", () => {
    expect(presenceChange("A", "A", false)).toBeUndefined()
  })

  test("a stale presence never hides the dock for a different active request", () => {
    expect(permissionInlineVisible("A", "B")).toBe(false)
    expect(permissionInlineVisible("A", "A")).toBe(true)
    expect(permissionInlineVisible(undefined, "A")).toBe(false)
    expect(permissionInlineVisible("A", undefined)).toBe(false)
  })

  test("scrolling the card out of the virtual range re-shows the dock, scrolling back hides it again", () => {
    const events: Event[] = [
      { kind: "active", request: "A" },
      { kind: "mount", request: "A" },
      { kind: "cleanup", request: "A" },
      { kind: "mount", request: "A" },
    ]
    const frames = replay(presenceByID, events)
    expect(frames.map((f) => f.card + f.dock)).toEqual([1, 1, 1, 1])
  })
})
