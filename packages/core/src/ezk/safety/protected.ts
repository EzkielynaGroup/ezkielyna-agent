// Ezkielyna Agent Wave B (S1): paths that still ask in every mode except Penuh (full), even inside the project.
// There is ONE list (./protected-paths: tools, modes and the sandbox share it); this file keeps the names the mode decision uses.
import path from "node:path"
import { isProtectedRelative } from "./protected-paths"

/** `rel` is relative to the project root; any protected segment, `.env` / `.env.*` or `.github/workflows` counts. */
export const isProtectedPath = isProtectedRelative

export function within(file: string, root: string) {
  const rel = path.relative(root, file)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}
