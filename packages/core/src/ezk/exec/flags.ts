// Ezkielyna Agent v3 Wave B "exec" lane flags. Same kill-switch style as the rest of the agent:
//   EZK_FEATURES="+exec,+statusline,-exec-cli"
//   exec        default OFF  unified exec: bash gains yield_time_ms / run_in_background / monitor / tty and the
//                            write_stdin, exec_list, exec_stop tools are offered. Changes the tool list, so opt-in.
//   exec-cli    default ON   the `ezkielyna exec` command. Only runs when a user types it; changes nothing else.
//   diagnostics default ON   /context, /usage and `ezkielyna doctor`. Read-only, user-invoked, no prompt bytes.
//   statusline  default OFF  TUI footer line with context %, cost and cache hit. Changes the default TUI look.
export type ExecFeature = "exec" | "exec-cli" | "diagnostics" | "statusline"

const DEFAULTS: Record<ExecFeature, boolean> = {
  exec: false,
  "exec-cli": true,
  diagnostics: true,
  statusline: false,
}

export function execEnabled(feature: ExecFeature, env: Record<string, string | undefined> = process.env): boolean {
  return (env.EZK_FEATURES ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .reduce((on, item) => {
      if (item === `-${feature}`) return false
      if (item === `+${feature}` || item === feature) return true
      return on
    }, DEFAULTS[feature])
}
