import { deepMerge, type Obj } from "./merge"

export const DEFAULTS = { server: { port: 80, host: "0.0.0.0" }, plugins: ["log"] }

export function loadConfig(user: Obj) {
  return deepMerge(DEFAULTS, user)
}
