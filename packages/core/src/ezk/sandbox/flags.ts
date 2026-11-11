// Ezkielyna Agent v3 (Wave C S6): sandbox feature switch and permission-mode stub. Pure, no dependencies.
//
// EZK_FEATURES="+sandbox" turns the OS sandbox on for every mode that allows it, "-sandbox" turns it off everywhere.
// Unset (the default, because this changes how commands run): only the modes the safety lane introduces
// ("Edit otomatis" and "Otomatis-aman") sandbox. Today no session is in those modes, so nothing changes until either
// the safety lane lands or a user opts in with +sandbox.

/** The permission modes of DESIGN-V3 S1 (owned by the safety lane; mirrored here so the sandbox can be wired now). */
export type PermissionMode = "ask" | "acceptEdits" | "plan" | "safeAuto" | "full"

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "acceptEdits", "plan", "safeAuto", "full"]

export type SandboxSwitch = "on" | "off" | "default"

export function sandboxSwitch(env: Record<string, string | undefined> = process.env): SandboxSwitch {
  let state: SandboxSwitch = "default"
  for (const raw of (env.EZK_FEATURES ?? "").split(",")) {
    const item = raw.trim().toLowerCase()
    if (item === "-sandbox") state = "off"
    if (item === "+sandbox" || item === "sandbox") state = "on"
  }
  return state
}

/**
 * Whether commands in `mode` run inside the OS sandbox (before availability is checked).
 *   full ("Penuh")                 never (the user chose no guard rails; the mode already shows a warning)
 *   acceptEdits / safeAuto         yes unless -sandbox
 *   ask ("Tanya dulu") / plan      only with +sandbox: the user is asked first, then the command runs sandboxed
 */
export function sandboxWanted(mode: PermissionMode, state: SandboxSwitch) {
  if (state === "off" || mode === "full") return false
  if (state === "on") return true
  return mode === "acceptEdits" || mode === "safeAuto"
}

/**
 * Stub until the safety lane's mode store is merged: EZK_PERMISSION_MODE (ask | acceptEdits | plan | safeAuto |
 * full), default "ask" (today's behaviour). The safety lane replaces the call site with the session's real mode.
 */
export function permissionModeFromEnv(env: Record<string, string | undefined> = process.env): PermissionMode {
  const value = env.EZK_PERMISSION_MODE?.trim()
  return PERMISSION_MODES.find((mode) => mode === value) ?? "ask"
}
