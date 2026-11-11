// Confines file access to the chosen folder. Used to refuse permission requests that reach outside it.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function realish(p: string, paths: typeof path): string {
  // realpath of the nearest existing ancestor + the remainder, so symlinks inside the root cannot escape and new files work.
  let cur = paths.resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      return paths.join(fs.realpathSync(cur), ...rest.reverse())
    } catch {
      const parent = paths.dirname(cur)
      if (parent === cur) return paths.resolve(p)
      rest.push(paths.basename(cur))
      cur = parent
    }
  }
}

export function isInside(root: string, target: string, paths: typeof path = path): boolean {
  const base = realish(root, paths)
  const t = target.startsWith("~") ? paths.join(os.homedir(), target.slice(1)) : target
  const abs = realish(paths.isAbsolute(t) ? t : paths.join(base, t), paths)
  const rel = paths.relative(base, abs)
  return rel === "" || (!rel.startsWith("..") && !paths.isAbsolute(rel))
}

// Include drive-letter and UNC roots. Without these alternatives Windows shell paths such as
// `C:\\Users\\...` and `\\\\server\\share\\...` bypass command-path checks.
const PATHISH = /(?:^|[\s"'=:(<>|;&])((?:[A-Za-z]:[\\/]|\\\\|\/\/|~|\.{1,2}|\/)[^\s"'|;&<>)]*)/g

/** Path-like tokens in a free-form string (a shell command, a glob). Heuristic: false negatives are possible, never auto-allow on it. */
export function pathTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PATHISH)) {
    const tok = m[1]
    if (tok && tok !== "." && tok !== "/dev/null") out.push(tok.replace(/\*+.*$/, "") || "/")
  }
  return out
}

/** First path in the text that escapes root, or undefined. */
export function findEscape(root: string, text: string, paths: typeof path = path): string | undefined {
  return pathTokens(text).find((p) => !isInside(root, p, paths))
}
