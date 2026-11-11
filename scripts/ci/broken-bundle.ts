// Output fragments that mean a packaged build cannot load one of its own modules.
// Shared by smoke-cli.ts and smoke-desktop.ts.
export const BROKEN_BUNDLE = [
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "Cannot find module",
  "Cannot find package",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_DLOPEN_FAILED",
]

export function findBrokenBundle(output: string) {
  const line = output.split(/\r?\n/).find((line) => BROKEN_BUNDLE.some((pattern) => line.includes(pattern)))
  return line?.trim().slice(0, 500)
}
