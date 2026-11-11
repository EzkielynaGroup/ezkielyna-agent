// X1 `--output-schema`: parse the final message as JSON and check it against a JSON Schema. A small validator for the
// keywords CI schemas use (type, properties, required, additionalProperties, items, enum, const, anyOf/oneOf/allOf,
// min/max, minLength/maxLength, minItems/maxItems, pattern, local $ref). Other keywords are ignored, never rejected.
export type SchemaCheck = { ok: true; value: unknown } | { ok: false; errors: string[] }

export function checkOutput(text: string, schema: unknown): SchemaCheck {
  const value = parseJson(text)
  if (value === undefined) return { ok: false, errors: ["the final message is not valid JSON"] }
  const errors = validate(value, schema, "$", schema, 0)
  return errors.length ? { ok: false, errors } : { ok: true, value }
}

/** Accepts bare JSON or one fenced ```json block, which weaker models add even when told not to. */
export function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(text)
  for (const candidate of [text.trim(), fenced?.[1]?.trim()]) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {}
  }
  return undefined
}

function validate(value: unknown, schema: unknown, at: string, root: unknown, depth: number): string[] {
  if (depth > 64 || schema === true || schema === undefined) return []
  if (schema === false) return [`${at}: not allowed`]
  if (!isObject(schema)) return []
  if (typeof schema.$ref === "string") return validate(value, resolveRef(schema.$ref, root), at, root, depth + 1)
  const errors: string[] = []
  const type = schema.type
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]
    if (!types.some((t) => matchesType(value, String(t)))) return [`${at}: expected ${types.join(" or ")}, got ${typeName(value)}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => equal(option, value))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`)
  if ("const" in schema && !equal(schema.const, value)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.allOf)) errors.push(...schema.allOf.flatMap((s) => validate(value, s, at, root, depth + 1)))
  for (const key of ["anyOf", "oneOf"] as const) {
    const list = schema[key]
    if (Array.isArray(list) && !list.some((s) => validate(value, s, at, root, depth + 1).length === 0)) errors.push(`${at}: does not match any allowed shape`)
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`)
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`)
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`)
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`)
    if (typeof schema.pattern === "string" && !safeRegex(schema.pattern)?.test(value)) errors.push(`${at}: does not match ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`)
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`)
    if (schema.items !== undefined && !Array.isArray(schema.items))
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${at}[${i}]`, root, depth + 1)))
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    required.filter((key) => !(String(key) in value)).forEach((key) => errors.push(`${at}.${key}: is required`))
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) errors.push(...validate(item, properties[key], `${at}.${key}`, root, depth + 1))
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: is not allowed`)
      else if (isObject(schema.additionalProperties)) errors.push(...validate(item, schema.additionalProperties, `${at}.${key}`, root, depth + 1))
    }
  }
  return errors
}

function resolveRef(ref: string, root: unknown) {
  if (!ref.startsWith("#")) return undefined
  return ref
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), root)
}

function matchesType(value: unknown, type: string) {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value)
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  if (type === "null") return value === null
  if (type === "array") return Array.isArray(value)
  if (type === "object") return isObject(value)
  return typeof value === type
}

function typeName(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function equal(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function safeRegex(pattern: string) {
  try {
    return new RegExp(pattern, "u")
  } catch {
    return undefined
  }
}
