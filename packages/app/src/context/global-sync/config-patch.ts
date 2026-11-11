export function configPatchChanges(current: unknown, patch: unknown): boolean {
  if (!isRecord(patch)) return !equal(current, patch)
  if (!isRecord(current)) return Object.keys(patch).some((key) => patch[key] !== undefined)

  return Object.entries(patch).some(([key, value]) => {
    if (value === undefined) return current[key] !== undefined
    if (isRecord(value)) return configPatchChanges(current[key], value)
    return !equal(current[key], value)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => equal(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false

  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined)
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
}
