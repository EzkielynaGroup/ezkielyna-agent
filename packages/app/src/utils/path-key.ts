export type PathKey = string & { _brand: "PathKey" }

const isDrive = (value: string) => {
  if (value.length !== 2) return false
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

export const pathKey = (path: string) => {
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  const trimmed = trimTrailingSlashes(value)
  if (!trimmed && value.startsWith("/")) return "/" as PathKey
  if (isDrive(trimmed)) return `${trimmed}/` as PathKey
  return trimmed as PathKey
}

// macOS exposes these top-level folders as symlinks into /private (/var -> /private/var, /tmp -> /private/tmp, /etc -> /private/etc).
// The server resolves every directory it opens to its real path (so a session started in "/var/x" is stored as
// "/private/var/x"), while the app keeps the path the user or the shell handed it. Both names are the same folder.
const MAC_PRIVATE_ALIAS = /^\/private(\/(?:var|tmp|etc)(?:\/|$))/

/**
 * Key for deciding whether two paths name the same folder when one side may be the server's resolved path.
 * Use it for matching sessions to projects only: `pathKey` stays the storage key, so persisted data is unaffected.
 */
export const directoryMatchKey = (path: string) => pathKey(path).replace(MAC_PRIVATE_ALIAS, "$1") as PathKey
