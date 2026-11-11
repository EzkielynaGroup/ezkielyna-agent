// Ezkielyna Agent: which permission request currently has an inline card mounted in the timeline.
//
// The composer's permission dock is hidden while the inline card for the *active* request is mounted. This used to be one
// shared boolean fed by an IntersectionObserver. Two things made that flicker (ezk.8, fixed in 6788bba324):
//   1. the dock changes the timeline height, so "card visible" toggled the dock, which moved the card, which toggled it back;
//   2. when request A was answered and request B arrived, A's card cleaned up *after* B's card had mounted and cleared the
//      flag, so B's card and the dock showed at the same time.
// Presence is therefore keyed by request id, and a cleanup only clears its own id.

export type PermissionInlinePresence = string | undefined

/** A card for `requestID` mounted (`present` true) or unmounted (`present` false). */
export function presenceChange(
  current: PermissionInlinePresence,
  requestID: string,
  present: boolean,
): PermissionInlinePresence {
  if (present) return requestID
  return current === requestID ? undefined : current
}

/** The dock stays hidden only while the mounted card belongs to the request the composer treats as active. */
export function permissionInlineVisible(
  presence: PermissionInlinePresence,
  activeRequestID: string | undefined,
): boolean {
  return presence !== undefined && activeRequestID === presence
}
