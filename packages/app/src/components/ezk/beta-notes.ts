export const BETA_NOTES = {
  "5": ["ezk.beta.note.5.1", "ezk.beta.note.5.2", "ezk.beta.note.5.3"],
} as const

const DEFAULT_NOTES = ["ezk.beta.note.default.1", "ezk.beta.note.default.2", "ezk.beta.note.default.3"] as const

export function betaNotesForVersion(version: string) {
  const release = version.match(/-ezk\.(\d+)/)?.[1]
  return release && Object.hasOwn(BETA_NOTES, release) ? BETA_NOTES[release as keyof typeof BETA_NOTES] : DEFAULT_NOTES
}
