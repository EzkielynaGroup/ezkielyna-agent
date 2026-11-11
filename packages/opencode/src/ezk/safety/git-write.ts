// git subcommands that change project state (index, refs, config, hooks). Shared by the bash scan (tool/shell.ts) and the
// write_stdin scan (ezk/exec/run.ts) so both treat them as a protected write.
export const GIT_WRITE_COMMANDS = new Set([
  "add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "config", "fetch", "gc",
  "init", "merge", "mv", "pull", "push", "rebase", "reflog", "remote", "reset", "restore", "rm", "stash", "switch",
  "tag", "worktree",
])

/** True when typed text (a REPL or shell prompt input, possibly several lines) contains `git <writing subcommand>`. */
export function mentionsGitWrite(text: string) {
  return text.split(/[\n;&|(`'"]+/).some((part) => {
    const words = part.trim().split(/\s+/)
    const exe = words[0]?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "").toLowerCase()
    return exe === "git" && GIT_WRITE_COMMANDS.has(words[1]?.toLowerCase() ?? "")
  })
}
