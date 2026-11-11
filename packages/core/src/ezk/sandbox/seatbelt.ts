// macOS sandbox: Seatbelt profile generator for /usr/bin/sandbox-exec.
//
// The profile is adapted from the OpenAI Codex CLI's Seatbelt policies (codex-rs/sandboxing: seatbelt_base_policy.sbpl,
// seatbelt_network_policy.sbpl and the writable-root rules in seatbelt.rs), Copyright OpenAI, Apache License 2.0;
// see NOTICE. Changes: our protected names, a read-everything base, roots passed as -D parameters, no proxy mode.
import fs from "node:fs"
import path from "node:path"

/** Absolute path on purpose: a `sandbox-exec` planted earlier in PATH must not be able to replace the real one. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

export function seatbeltAvailable(exists: (file: string) => boolean = fs.existsSync) {
  return exists(SANDBOX_EXEC)
}

const BASE = `(version 1)

; Closed by default (the approach of Chromium's and Codex's macOS sandboxes).
(deny default)

; Child processes inherit this policy.
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

; Reading is allowed everywhere so tools, compilers and caches work; writing is limited below.
(allow file-read*)
(allow user-preference-read)

(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; Hardware and kernel facts that runtimes (Node, Python, Go, Rust) read at startup. Read-only.
(allow sysctl-read
  (sysctl-name-prefix "hw.")
  (sysctl-name-prefix "kern.")
  (sysctl-name-prefix "machdep.cpu.")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "sysctl.proc_native")
  (sysctl-name "sysctl.proc_translated")
  (sysctl-name "vm.loadavg")
  (sysctl-name "security.mac.lockdown_mode_state"))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))

(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))

; User and group lookups (getpwuid), Python multiprocessing semaphores, power assertions.
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control"))
(allow ipc-posix-sem)

; Pseudo-terminals (openpty), for tools that check isatty or spawn a pty.
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
`

const NETWORK = `
; Network allowed (only after the user approved it for this command).
(allow network-outbound)
(allow network-inbound)
(allow system-socket)
(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))
(allow sysctl-read (sysctl-name-regex #"^net.routetable"))
`

/** Escapes a literal for an SBPL #"..." regex (POSIX ERE). */
export function regexEscape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&")
}

/**
 * The profile text. Writable roots are referenced as parameters WRITABLE_ROOT_<i> (given with -D) so the profile
 * itself does not depend on paths. Inside every writable root the protected names stay read-only, also when they do
 * not exist yet (the regex blocks creating `.git` or `.ssh` anywhere under a writable root).
 */
export function seatbeltProfile(input: { writableCount: number; protectedNames: readonly string[]; network: boolean }) {
  const names = input.protectedNames.map(regexEscape).join("|")
  const roots = Array.from({ length: input.writableCount }, (_, i) =>
    [
      `  (require-all`,
      `    (subpath (param "WRITABLE_ROOT_${i}"))`,
      ...(names ? [`    (require-not (regex #"/(${names})(/|$)"))`] : []),
      `  )`,
    ].join("\n"),
  )
  const write = roots.length
    ? `\n; Writable roots minus the protected names.\n(allow file-write*\n${roots.join("\n")})\n`
    : ""
  return BASE + write + (input.network ? NETWORK : "")
}

/** argv prefix: `sandbox-exec -p <profile> -DWRITABLE_ROOT_0=<dir> ... --`, then the shell and the command. */
export function seatbeltArgs(input: { writable: string[]; protectedNames: readonly string[]; network: boolean }) {
  const profile = seatbeltProfile({
    writableCount: input.writable.length,
    protectedNames: input.protectedNames,
    network: input.network,
  })
  return [SANDBOX_EXEC, "-p", profile, ...input.writable.map((dir, i) => `-DWRITABLE_ROOT_${i}=${dir}`), "--"]
}

/**
 * macOS paths reach the kernel through their real location (/var -> /private/var, /tmp -> /private/tmp), and
 * Seatbelt matches the real path, so roots are given in both forms when they differ.
 */
export function seatbeltRoots(dirs: string[], realpath: (file: string) => string = safeRealpath) {
  return [...new Set(dirs.flatMap((dir) => [path.resolve(dir), realpath(dir)]))]
}

function safeRealpath(file: string) {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
