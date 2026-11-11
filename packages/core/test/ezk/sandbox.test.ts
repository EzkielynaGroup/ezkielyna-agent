import { describe, expect, test } from "bun:test"
import {
  PERMISSION_MODES,
  PROTECTED_NAMES,
  SANDBOX_EXEC,
  bwrapArgs,
  denialNote,
  detectDenial,
  escalationTitle,
  isPosixShell,
  permissionModeFromEnv,
  sandboxFor,
  sandboxSwitch,
  sandboxWanted,
  seatbeltArgs,
  seatbeltProfile,
  seatbeltRoots,
  unavailableTip,
  type SandboxOptions,
} from "../../src/ezk/sandbox"

const ON = { EZK_FEATURES: "+sandbox" }
const linux = (extra: Partial<SandboxOptions> = {}): SandboxOptions => ({
  platform: "linux",
  env: ON,
  tmpdir: "/tmp",
  exists: (file) => file !== "/proj/.ssh" && file !== "/proj/.aws",
  bwrap: () => ({ path: "/usr/bin/bwrap" }),
  shell: "/bin/bash",
  ...extra,
})

describe("feature switch and modes", () => {
  test("EZK_FEATURES parsing: last word wins, default otherwise", () => {
    expect(sandboxSwitch({})).toBe("default")
    expect(sandboxSwitch({ EZK_FEATURES: "-router,+sandbox" })).toBe("on")
    expect(sandboxSwitch({ EZK_FEATURES: "+sandbox, -sandbox" })).toBe("off")
    expect(sandboxSwitch({ EZK_FEATURES: "sandbox" })).toBe("on")
  })

  test("mode matrix", () => {
    const table = Object.fromEntries(
      PERMISSION_MODES.map((mode) => [
        mode,
        (["default", "on", "off"] as const).map((state) => sandboxWanted(mode, state)),
      ]),
    )
    expect(table).toEqual({
      // default, +sandbox, -sandbox
      ask: [false, true, false],
      acceptEdits: [true, true, false],
      plan: [false, true, false],
      safeAuto: [true, true, false],
      full: [false, false, false],
    })
  })

  test("mode stub reads EZK_PERMISSION_MODE, ask by default", () => {
    expect(permissionModeFromEnv({})).toBe("ask")
    expect(permissionModeFromEnv({ EZK_PERMISSION_MODE: "acceptEdits" })).toBe("acceptEdits")
    expect(permissionModeFromEnv({ EZK_PERMISSION_MODE: "nonsense" })).toBe("ask")
  })
})

describe("bubblewrap arguments", () => {
  const args = bwrapArgs({
    bwrap: "/usr/bin/bwrap",
    writable: ["/proj", "/tmp"],
    protectedNames: PROTECTED_NAMES,
    network: false,
    cwd: "/proj/src",
    exists: (file) => file === "/proj/.git" || file === "/proj/.ezkielyna",
  })

  test("system read-only, roots writable, existing protected names read-only on top, no network", () => {
    expect(args.slice(0, 8)).toEqual(["/usr/bin/bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"])
    const text = args.join(" ")
    expect(text).toContain("--bind /proj /proj")
    expect(text).toContain("--bind /tmp /tmp")
    expect(text).toContain("--ro-bind /proj/.git /proj/.git")
    expect(text).toContain("--ro-bind /proj/.ezkielyna /proj/.ezkielyna")
    expect(text).not.toContain("/proj/.ssh")
    expect(text.indexOf("--bind /proj /proj")).toBeLessThan(text.indexOf("--ro-bind /proj/.git"))
    expect(args).toContain("--unshare-ipc") // no shared System V IPC / POSIX message queues with the host
    expect(args).toContain("--unshare-net")
    expect(args.slice(-3)).toEqual(["--chdir", "/proj/src", "--"])
  })

  test("network allowed drops --unshare-net only", () => {
    const open = bwrapArgs({
      bwrap: "/usr/bin/bwrap",
      writable: ["/proj"],
      protectedNames: [],
      network: true,
      cwd: "/proj",
      exists: () => false,
    })
    expect(open).not.toContain("--unshare-net")
    expect(open).toContain("--die-with-parent")
  })
})

describe("sandboxFor", () => {
  test("Linux: bwrap wrap, network off, writable project + tmp + extra", () => {
    const plan = sandboxFor("npm test", "acceptEdits", "/proj", linux({ extraWritable: ["/data"], exists: () => true }))
    expect(plan.kind).toBe("bwrap")
    expect(plan.network).toBe(false)
    expect(plan.writable).toEqual(["/proj", "/tmp", "/data"])
    expect(plan.wrap?.[0]).toBe("/usr/bin/bwrap")
    expect(plan.wrap?.at(-1)).toBe("--")
  })

  test("no wrap: feature off, mode full, Windows, non-POSIX shell, escalated", () => {
    expect(sandboxFor("ls", "ask", "/proj", linux({ env: {} })).wrap).toBeNull()
    expect(sandboxFor("ls", "acceptEdits", "/proj", linux({ env: { EZK_FEATURES: "-sandbox" } })).wrap).toBeNull()
    expect(sandboxFor("ls", "full", "/proj", linux()).reason).toBe("mode full")
    expect(sandboxFor("ls", "acceptEdits", "/proj", linux({ platform: "win32" })).wrap).toBeNull()
    expect(sandboxFor("ls", "acceptEdits", "/proj", linux({ shell: "/usr/bin/pwsh" })).wrap).toBeNull()
    expect(sandboxFor("ls", "acceptEdits", "/proj", linux({ escalation: "require_escalated" })).reason).toBe(
      "escalated by the user",
    )
  })

  test("with_network keeps the filesystem rules and allows the network", () => {
    const plan = sandboxFor("bun install", "acceptEdits", "/proj", linux({ escalation: "with_network" }))
    expect(plan.network).toBe(true)
    expect(plan.wrap).not.toContain("--unshare-net")
  })

  test("missing bwrap: no wrap, an unavailable reason for the one-line tip", () => {
    const plan = sandboxFor(
      "ls",
      "acceptEdits",
      "/proj",
      linux({ bwrap: () => ({ path: undefined, error: "bubblewrap (bwrap) is not installed" }) }),
    )
    expect(plan.wrap).toBeNull()
    expect(plan.unavailable).toContain("not installed")
    expect(unavailableTip(plan, "en")).toContain("sudo apt install bubblewrap")
    expect(unavailableTip(plan, "id")).toContain("pasang bubblewrap")
  })

  test("macOS: sandbox-exec with the profile and one parameter per writable root", () => {
    const plan = sandboxFor("make", "safeAuto", "/Users/a/proj", {
      platform: "darwin",
      env: ON,
      tmpdir: "/var/folders/x/T",
      exists: () => true,
      seatbelt: () => true,
    })
    expect(plan.kind).toBe("seatbelt")
    expect(plan.wrap?.[0]).toBe(SANDBOX_EXEC)
    expect(plan.wrap).toContain("-DWRITABLE_ROOT_0=/Users/a/proj")
    expect(plan.wrap).toContain("-DWRITABLE_ROOT_2=/tmp")
    expect(plan.wrap?.at(-1)).toBe("--")
  })

  test("POSIX shells only", () => {
    expect(isPosixShell("/bin/zsh")).toBe(true)
    expect(isPosixShell("/usr/local/bin/fish")).toBe(true)
    expect(isPosixShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(false)
  })
})

describe("Seatbelt profile", () => {
  const closed = seatbeltProfile({ writableCount: 2, protectedNames: PROTECTED_NAMES, network: false })
  const open = seatbeltProfile({ writableCount: 1, protectedNames: PROTECTED_NAMES, network: true })

  test("deny by default, read everything, write only the parameterised roots", () => {
    expect(closed.startsWith("(version 1)")).toBe(true)
    expect(closed).toContain("(deny default)")
    expect(closed).toContain("(allow file-read*)")
    expect(closed).toContain('(subpath (param "WRITABLE_ROOT_0"))')
    expect(closed).toContain('(subpath (param "WRITABLE_ROOT_1"))')
    expect(closed).not.toContain("WRITABLE_ROOT_2")
  })

  test("protected names are excluded from every root, escaped, also when not created yet", () => {
    // the names come from the shared protected-paths list (ezk/safety/protected-paths)
    const names = PROTECTED_NAMES.map((name) => name.replaceAll(".", "\\.")).join("|")
    expect(closed).toContain(`(require-not (regex #"/(${names})(/|$)"))`)
    expect(closed).toContain("\\.git|\\.ezkielyna|\\.claude|\\.codex|\\.agents|\\.ssh|\\.aws")
    expect(closed.match(/require-not/g)).toHaveLength(2)
  })

  test("network rules only when allowed", () => {
    expect(closed).not.toContain("network-outbound")
    expect(open).toContain("(allow network-outbound)")
    expect(open).toContain("com.apple.SystemConfiguration.DNSConfiguration")
  })

  test("balanced parentheses (a malformed profile makes sandbox-exec refuse to start)", () => {
    for (const profile of [closed, open]) {
      const code = profile
        .split("\n")
        .map((line) => line.replace(/;.*$/, ""))
        .join("\n")
        .replace(/#"[^"]*"/g, "")
        .replace(/"[^"]*"/g, "")
      expect(code.split("(").length).toBe(code.split(")").length)
    }
  })

  test("args and real-path roots", () => {
    const args = seatbeltArgs({ writable: ["/a", "/b"], protectedNames: [], network: false })
    expect(args.slice(0, 2)).toEqual([SANDBOX_EXEC, "-p"])
    expect(args.slice(3)).toEqual(["-DWRITABLE_ROOT_0=/a", "-DWRITABLE_ROOT_1=/b", "--"])
    expect(
      seatbeltRoots(["/var/folders/x", "/proj"], (dir) => (dir.startsWith("/var") ? `/private${dir}` : dir)),
    ).toEqual(["/var/folders/x", "/private/var/folders/x", "/proj"])
  })
})

describe("denial detection", () => {
  const plan = sandboxFor("x", "acceptEdits", "/proj", linux())

  test("file and network denials when sandboxed and failed", () => {
    expect(
      detectDenial({ output: "touch: cannot touch '/home/x': Read-only file system", exitCode: 1, plan })?.kind,
    ).toBe("file")
    expect(detectDenial({ output: "curl: (6) Could not resolve host: example.com", exitCode: 6, plan })?.kind).toBe(
      "network",
    )
    expect(detectDenial({ output: "npm ERR! getaddrinfo EAI_AGAIN registry.npmjs.org", exitCode: 1, plan })?.kind).toBe(
      "network",
    )
  })

  test("nothing when it succeeded, ran unsandboxed, or had the network", () => {
    expect(detectDenial({ output: "Read-only file system", exitCode: 0, plan })).toBeUndefined()
    const none = sandboxFor("x", "full", "/proj", linux())
    expect(detectDenial({ output: "Permission denied", exitCode: 1, plan: none })).toBeUndefined()
    const net = sandboxFor("x", "acceptEdits", "/proj", linux({ escalation: "with_network" }))
    expect(detectDenial({ output: "Could not resolve host: x", exitCode: 6, plan: net })).toBeUndefined()
  })

  test("the note tells the model how to escalate", () => {
    const note = denialNote({ kind: "network", line: "Could not resolve host" }, plan)
    expect(note).toContain('sandbox_permissions "with_network"')
    expect(note).toContain("The user will be asked to approve it")
    expect(denialNote({ kind: "file", line: "Read-only file system" }, plan)).toContain('"require_escalated"')
  })

  test("approval titles in English and Indonesian", () => {
    expect(escalationTitle("with_network", "id")).toBe("Jalankan perintah dengan akses internet")
    expect(escalationTitle("require_escalated", "en")).toBe("Run the command outside the sandbox")
  })
})
