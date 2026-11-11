// The release build names chunks with Bun's `[hash13]` token (script/build.ts), which exists from Bun 1.4.3. Older Bun versions take
// the token literally, every chunk with the same name collapses onto one file, and the build dies with
// "Multiple files share the same output path". Fail early with a message that says what to do instead.
export const MINIMUM_BUN = "1.4.3"

export function assertMinimumBun(version: string = Bun.version, minimum: string = MINIMUM_BUN) {
  if (Bun.semver.satisfies(version, `>=${minimum}`)) return
  throw new Error(
    `This build needs Bun ${minimum} or newer (found ${version}). Chunk names use the [hash13] token that older Bun versions do not know, ` +
      `so the bundle would fail with "Multiple files share the same output path". Upgrade with \`bun upgrade\` (or install bun@${minimum}) and run the build again.`,
  )
}
