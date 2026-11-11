// Shared rule identity tracking. Keep this leaf separate so constructing the
// default agent does not load the opt-in permission modes and rule engine.
const defaults = new WeakSet<object>()

export function markDefaults(rules: readonly object[]) {
  for (const rule of rules) defaults.add(rule)
}

export function isDefaultRule(rule: object) {
  return defaults.has(rule)
}
