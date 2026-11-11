// Linux sandbox: bubblewrap argument builder and availability probe.
// Filesystem view (same idea as Codex's linux-sandbox, Apache-2.0): the whole system read-only, the writable roots
// bound read-write on top, then the protected names inside each writable root bound read-only again.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/**
 * Fixed locations only: a `bwrap` found through PATH could be planted by the project itself
 * (node_modules/.bin, a venv), which would let the sandboxed command choose its own sandbox.
 */
export const BWRAP_PATHS = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"]

export function bwrapArgs(input: {
  bwrap: string
  /** Writable directories (project root, temp dir, the agent's data dir), already resolved. */
  writable: string[]
  /** Names kept read-only inside every writable root (".git", ".ssh", ...). */
  protectedNames: readonly string[]
  network: boolean
  cwd: string
  exists?: (file: string) => boolean
}): string[] {
  const exists = input.exists ?? fs.existsSync
  const args = [input.bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]
  // Unix sockets are files, so --unshare-net does not hide them: /run holds the Docker and containerd sockets and the
  // per-user ssh-agent / D-Bus sockets (/run/user/*). An empty tmpfs hides all of it; the DNS stub stays readable when the
  // network is allowed (resolv.conf usually points into /run/systemd/resolve).
  args.push("--tmpfs", "/run")
  if (input.network) args.push("--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve")
  // /run is already empty; these keep the sockets masked if a later bind or a different layout brings them back.
  args.push("--ro-bind", "/dev/null", "/run/docker.sock", "--tmpfs", "/run/containerd")
  // /var/run is normally a symlink to /run; where it is a real directory, mask the socket in place (only if it exists:
  // a bind target that does not exist cannot be created on the read-only root).
  for (const sock of ["/var/run/docker.sock"]) if (exists(sock)) args.push("--ro-bind", "/dev/null", sock)
  for (const dir of input.writable) args.push("--bind", dir, dir)
  // Only existing paths can be re-bound: a bind target that does not exist would be created on the host as an empty
  // file or directory (the writable root is a host bind mount), which would break e.g. a later `git init`.
  for (const dir of input.writable)
    for (const name of input.protectedNames) {
      const target = path.join(dir, name)
      if (exists(target)) args.push("--ro-bind", target, target)
    }
  if (!input.network) args.push("--unshare-net")
  // A fresh session stops TIOCSTI-style input injection into the user's terminal; die-with-parent avoids orphans.
  args.push("--unshare-pid", "--unshare-ipc", "--new-session", "--die-with-parent", "--chdir", input.cwd, "--")
  return args
}

let probed: { path: string | undefined; error?: string } | undefined

/**
 * The first bwrap from BWRAP_PATHS that can actually create its namespaces here (kernels or AppArmor profiles can
 * forbid unprivileged user namespaces, e.g. Ubuntu 24.04 without the bwrap profile). Probed once per process.
 */
export function findBwrap(opts: { paths?: string[]; refresh?: boolean } = {}) {
  if (probed && !opts.refresh) return probed
  const candidate = (opts.paths ?? BWRAP_PATHS).find((file) => fs.existsSync(file))
  if (!candidate) return (probed = { path: undefined, error: "bubblewrap (bwrap) is not installed" })
  const result = spawnSync(
    candidate,
    ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-ipc", "--", "true"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5000,
    },
  )
  if (result.status === 0) return (probed = { path: candidate })
  const reason = result.stderr?.toString().trim().split("\n")[0] || result.error?.message || `exit ${result.status}`
  return (probed = { path: undefined, error: `bwrap cannot start here: ${reason}` })
}
