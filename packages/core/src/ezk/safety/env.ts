const SECRET_PART = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

export function scrubChildEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  override = source.EZK_ENV_PASSTHROUGH,
): Record<string, string> {
  const allowed = new Set((override ?? "").split(",").map((name) => name.trim().toUpperCase()).filter(Boolean))
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name.toUpperCase() === "EZK_ENV_PASSTHROUGH") continue
    if (SECRET_PART.test(name) && !allowed.has(name.toUpperCase())) continue
    out[name] = value
  }
  return out
}

/** Scrub inherited secrets, then add back variables intentionally declared for this child. */
export function childEnv(
  inherited: NodeJS.ProcessEnv | Record<string, string | undefined>,
  explicit: Record<string, string | undefined> = {},
  override = inherited.EZK_ENV_PASSTHROUGH,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out = scrubChildEnv(inherited, override)
  for (const [name, value] of Object.entries(explicit)) {
    if (value === undefined) continue
    if (platform === "win32") for (const existing of Object.keys(out)) if (existing !== name && existing.toUpperCase() === name.toUpperCase()) delete out[existing]
    out[name] = value
  }
  return out
}
