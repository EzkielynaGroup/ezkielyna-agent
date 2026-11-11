// Ezkielyna Agent v3 (Wave C S6): OS-level sandbox for shell commands.
//
// One integration point for the shell tool: sandboxFor(command, mode, projectRoot) -> { wrap, network }.
// `wrap` is an argv prefix; the tool appends `<shell> -c <command>` and spawns it. null = run as today.
//   Linux   bubblewrap: system read-only, project + temp + agent data writable, protected names read-only, no network
//   macOS   Seatbelt (sandbox-exec): the same rules as a deny-default profile
//   Windows no OS sandbox: approvals only
// Escalation (R1 §4.3): the model may ask to re-run with the network ("with_network") or outside the sandbox
// ("require_escalated"); the shell tool asks the user first. See packages/opencode/src/ezk/sandbox.ts.
import { SANDBOX_READONLY_NAMES } from "../safety/protected-paths"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { bwrapArgs, findBwrap } from "./bwrap"
import { seatbeltArgs, seatbeltAvailable, seatbeltRoots } from "./seatbelt"
import { sandboxSwitch, sandboxWanted, type PermissionMode } from "./flags"

export * from "./flags"
export { bwrapArgs, findBwrap, BWRAP_PATHS } from "./bwrap"
export { seatbeltArgs, seatbeltProfile, seatbeltRoots, SANDBOX_EXEC } from "./seatbelt"

/** Names kept read-only inside every writable root: the shared list (see ../safety/protected-paths). */
export const PROTECTED_NAMES: readonly string[] = SANDBOX_READONLY_NAMES

export type Escalation = "use_default" | "with_network" | "require_escalated"
export const ESCALATIONS: readonly Escalation[] = ["use_default", "with_network", "require_escalated"]

export type SandboxPlan = {
  /** argv prefix to run the command through, or null to run it unsandboxed (as today). */
  wrap: string[] | null
  /** Whether the command may use the network. */
  network: boolean
  kind: "bwrap" | "seatbelt" | "none"
  /** Why there is no sandbox (feature off, mode, platform, missing tool, escalation), for logs and the tip. */
  reason?: string
  /** Set when the sandbox was wanted but is not available here: show the one-line tip once. */
  unavailable?: string
  writable: string[]
}

export type SandboxOptions = {
  /** Directories besides the project root that stay writable (the agent's tool-output, log and tmp folders). The OS temp dir is added. */
  extraWritable?: string[]
  cwd?: string
  escalation?: Escalation
  /** The user's shell; only POSIX shells are wrapped (`<shell> -c <command>`). */
  shell?: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  /** Injected in tests. */
  bwrap?: () => { path: string | undefined; error?: string }
  seatbelt?: () => boolean
  exists?: (file: string) => boolean
  tmpdir?: string
}

export function sandboxFor(
  command: string,
  mode: PermissionMode,
  projectRoot: string,
  opts: SandboxOptions = {},
): SandboxPlan {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const writable = writableRoots(projectRoot, opts, platform)
  const none = (reason: string, unavailable?: string): SandboxPlan => ({
    wrap: null,
    network: true,
    kind: "none",
    reason,
    unavailable,
    writable,
  })

  if (!command.trim()) return none("empty command")
  if (!sandboxWanted(mode, sandboxSwitch(env))) return none(mode === "full" ? "mode full" : "sandbox off")
  if (opts.escalation === "require_escalated") return none("escalated by the user")
  if (platform === "win32") return none("windows has no OS sandbox; approvals only")
  if (opts.shell && !isPosixShell(opts.shell)) return none(`shell ${path.basename(opts.shell)} is not wrapped`)

  const network = opts.escalation === "with_network"
  const cwd = opts.cwd ?? projectRoot
  if (platform === "linux") {
    const found = (opts.bwrap ?? findBwrap)()
    if (!found.path) return none("bwrap unavailable", found.error)
    return {
      wrap: bwrapArgs({
        bwrap: found.path,
        writable,
        protectedNames: PROTECTED_NAMES,
        network,
        cwd,
        exists: opts.exists,
      }),
      network,
      kind: "bwrap",
      writable,
    }
  }
  if (platform === "darwin") {
    if (!(opts.seatbelt ?? seatbeltAvailable)()) return none("sandbox-exec unavailable", "sandbox-exec not found")
    const roots = opts.tmpdir ? writable : seatbeltRoots(writable)
    return {
      wrap: seatbeltArgs({ writable: roots, protectedNames: PROTECTED_NAMES, network }),
      network,
      kind: "seatbelt",
      writable: roots,
    }
  }
  return none(`no sandbox for ${platform}`)
}

// The project, the OS temp dir (plus /tmp on macOS, where TMPDIR is a per-user folder) and the agent's spill/log/scratch folders.
function writableRoots(projectRoot: string, opts: SandboxOptions, platform: NodeJS.Platform) {
  const tmp = opts.tmpdir ?? os.tmpdir()
  const dirs = [projectRoot, tmp, ...(platform === "darwin" ? ["/tmp"] : []), ...(opts.extraWritable ?? [])]
  const exists = opts.exists ?? fs.existsSync
  return [...new Set(dirs.map((dir) => path.resolve(dir)))].filter((dir) => exists(dir))
}

export function isPosixShell(shell: string) {
  return ["bash", "sh", "zsh", "dash", "ksh", "fish"].includes(
    path
      .basename(shell)
      .replace(/\.exe$/i, "")
      .toLowerCase(),
  )
}

const NETWORK_ERRORS =
  /could not resolve host|temporary failure in name resolution|name or service not known|nodename nor servname|getaddrinfo|enotfound|eai_again|network is unreachable|failed to establish a new connection|couldn't connect to server|failed to connect to|connection refused|no route to host|dial tcp|unable to access 'https?:/i
const FILE_ERRORS = /read-only file system|operation not permitted|permission denied|eacces|eperm|erofs/i

export type Denial = { kind: "network" | "file"; line: string }

/** Did a sandboxed command fail because of the sandbox? Only meaningful when it ran sandboxed and failed. */
export function detectDenial(input: {
  output: string
  exitCode: number | null
  plan: SandboxPlan
}): Denial | undefined {
  if (!input.plan.wrap || input.exitCode === 0) return undefined
  const lines = input.output.split("\n")
  const network = input.plan.network ? undefined : lines.find((line) => NETWORK_ERRORS.test(line))
  if (network) return { kind: "network", line: network.trim().slice(0, 200) }
  const file = lines.find((line) => FILE_ERRORS.test(line))
  if (file) return { kind: "file", line: file.trim().slice(0, 200) }
  return undefined
}

/** Plain-words note appended to the tool result (read by the model). English: tool results are model-facing. */
export function denialNote(denial: Denial, plan: SandboxPlan) {
  const blocked =
    denial.kind === "network"
      ? "it tried to use the network, which the sandbox blocks"
      : "it tried to write somewhere the sandbox does not allow (only the project folder and the temp folder are writable, and .git, .ezkielyna, .claude, .codex, .agents, .ssh and .aws are always read-only)"
  const ask =
    denial.kind === "network"
      ? `call the tool again with sandbox_permissions "with_network"`
      : `call the tool again with sandbox_permissions "require_escalated"`
  return [
    `This command ran in the ${plan.kind === "seatbelt" ? "macOS" : "Linux"} sandbox and was probably blocked: ${blocked}.`,
    `Blocked line: ${denial.line}`,
    `If the command really needs this, ${ask} and a one-line justification for the user. The user will be asked to approve it. Do not retry the same command unchanged.`,
  ].join("\n")
}

/** One-line tip when the sandbox is wanted but cannot run here. */
export function unavailableTip(plan: SandboxPlan, lang: "en" | "id" = "en") {
  const linux = plan.unavailable?.includes("not installed")
  if (lang === "id")
    return linux
      ? "Tips: pasang bubblewrap (misalnya `sudo apt install bubblewrap`) agar perintah jalan di sandbox. Sementara itu, setiap perintah tetap tanya dulu."
      : `Tips: sandbox tidak bisa dipakai di sini (${plan.unavailable}); setiap perintah tetap tanya dulu.`
  return linux
    ? "Tip: install bubblewrap (for example `sudo apt install bubblewrap`) so commands run in a sandbox; until then every command still asks."
    : `Tip: the sandbox cannot run here (${plan.unavailable}); every command still asks.`
}

/** Text for the approval prompt (TUI/desktop), EN and ID. */
export function escalationTitle(escalation: Escalation, lang: "en" | "id" = "en") {
  if (lang === "id")
    return escalation === "with_network"
      ? "Jalankan perintah dengan akses internet"
      : "Jalankan perintah di luar sandbox"
  return escalation === "with_network" ? "Run the command with internet access" : "Run the command outside the sandbox"
}
