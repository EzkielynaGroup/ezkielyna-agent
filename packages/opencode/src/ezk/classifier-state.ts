const epochs = new Map<string, number>()
const tripped = new Set<string>()

export const classifierEpoch = (sessionID: string) => epochs.get(sessionID) ?? 0
export const breakerTripped = (sessionID: string) => tripped.has(sessionID)

export function resetClassifier(sessionID: string) {
  epochs.set(sessionID, classifierEpoch(sessionID) + 1)
  tripped.delete(sessionID)
}

export function setClassifierTripped(sessionID: string, value: boolean) {
  if (value) tripped.add(sessionID)
  else tripped.delete(sessionID)
}
