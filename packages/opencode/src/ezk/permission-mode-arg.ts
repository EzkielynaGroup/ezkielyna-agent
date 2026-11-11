// Ezkielyna Agent Wave B (S1): `--permission-mode <mode>` for the TUI, `run` and `serve`.
// Passing the flag is the opt-in: it turns the modes feature on for this process (EZK_FEATURES=+modes).
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { FULL_WARNING, MODES, parseMode } from "@opencode-ai/core/ezk/safety/modes"

export const permissionModeOption = {
  type: "string",
  describe: `permission mode: ${MODES.join(", ")} (untrusted folders always ask)`,
} as const

/** Returns an error message for a bad value, else sets the env for this process (and its worker) and returns undefined. */
export function applyPermissionModeArg(value: unknown, env: Record<string, string | undefined> = process.env, warn: (text: string) => void = () => {}) {
  if (value === undefined || value === "") return
  const mode = parseMode(value)
  if (!mode) return `unknown --permission-mode "${String(value)}" (use one of: ${MODES.join(", ")})`
  env.EZK_PERMISSION_MODE = mode
  const features = (env.EZK_FEATURES ?? "").split(",").map((x) => x.trim()).filter(Boolean)
  if (!features.includes("+modes") && !features.includes("modes")) env.EZK_FEATURES = [...features.filter((x) => x !== "-modes"), "+modes"].join(",")
  if (mode === "full") warn(FULL_WARNING[detectLang(env)])
  return
}
