export type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null

/** Deep-merges `b` into a copy of `a`. Arrays in `b` replace arrays in `a`. Inputs are never mutated. */
export function deepMerge(a: Obj, b: Obj): Obj {
  const out = a
  for (const [key, value] of Object.entries(b)) {
    out[key] = isObj(value) && isObj(out[key]) ? deepMerge(out[key] as Obj, value) : value
  }
  return out
}
