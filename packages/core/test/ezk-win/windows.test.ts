// Windows readiness (v3 pass): every case simulates Windows with an explicit platform argument or path.win32.
import { describe, expect, test } from "bun:test"
import { killTree } from "../../src/ezk/process-tree"
import { pipeSpawnConfig, shellArgv } from "../../src/ezk/exec/backend"
import { hookShellCommand, hookWindowsHint } from "../../src/ezk/hooks/engine"
import { isProtectedPath, isProtectedRelative } from "../../src/ezk/safety/protected-paths"
import { decidePermission } from "../../src/ezk/exec/headless"
import { evaluateRules, type Rule } from "../../src/ezk/safety/rules"
import { stripJsonc } from "../../src/ezk/flags"
import { detectToolchain, resetSessionStartCache } from "../../src/ezk/context/session-start"

describe("killTree on Windows", () => {
  test("uses taskkill.exe /T /F and does not signal", () => {
    const calls: string[][] = []
    const signals: unknown[] = []
    killTree(42, { platform: "win32", run: (file, args) => (calls.push([file, ...args]), { status: 0, stdout: "" }), kill: (...a) => void signals.push(a) })
    expect(calls).toEqual([["taskkill.exe", "/PID", "42", "/T", "/F"]])
    expect(signals).toEqual([])
  })
  test("falls back to a direct kill when taskkill fails", () => {
    const signals: unknown[] = []
    killTree(42, { platform: "win32", signal: "SIGKILL", run: () => ({ status: 128, stdout: "" }), kill: (pid, signal) => void signals.push([pid, signal]) })
    expect(signals).toEqual([[42, "SIGKILL"]])
  })
})

describe("cmd.exe quoting for background commands", () => {
  const argv = shellArgv("C:\\Windows\\System32\\cmd.exe", 'echo "a b" && dir', "win32")
  test("cmd gets the command verbatim inside the quotes /s strips", () => {
    const config = pipeSpawnConfig(argv, "win32")
    expect(config.windowsVerbatimArguments).toBe(true)
    expect(config.args).toEqual(["/d", "/s", "/c", '"echo "a b" && dir"'])
  })
  test("PowerShell and POSIX shells keep normal argv quoting", () => {
    const ps = shellArgv("pwsh.exe", "Get-ChildItem", "win32")
    expect(pipeSpawnConfig(ps, "win32")).toEqual({ args: ps.args, windowsVerbatimArguments: false })
    const sh = shellArgv("/bin/zsh", "echo hi", "darwin")
    expect(pipeSpawnConfig(sh, "darwin")).toEqual({ args: sh.args, windowsVerbatimArguments: false })
    expect(pipeSpawnConfig(argv, "linux").windowsVerbatimArguments).toBe(false)
  })
})

describe("hook commands on Windows", () => {
  test("cmd.exe has no $VAR, so the project variables become %VAR%", () => {
    expect(hookShellCommand('"$CLAUDE_PROJECT_DIR"\\hooks\\check.cmd', "win32")).toBe('"%CLAUDE_PROJECT_DIR%"\\hooks\\check.cmd')
    expect(hookShellCommand("node ${EZK_PROJECT_DIR}/x.js", "win32")).toBe("node %EZK_PROJECT_DIR%/x.js")
    expect(hookShellCommand('"$CLAUDE_PROJECT_DIR"/x.sh', "linux")).toBe('"$CLAUDE_PROJECT_DIR"/x.sh')
  })
  test(".sh scripts get a hint on Windows only", () => {
    expect(hookWindowsHint("./hooks/lint.sh", "win32")).toContain("bash script.sh")
    expect(hookWindowsHint("bash hooks/lint.sh --fix", "win32")).not.toBe("")
    expect(hookWindowsHint("node hooks/lint.js", "win32")).toBe("")
    expect(hookWindowsHint("./hooks/lint.sh", "darwin")).toBe("")
  })
})

describe("protected paths, Windows spellings", () => {
  test("trailing dots/spaces, NTFS streams and 8.3 short names reach the same folder", () => {
    for (const rel of ["src\\.git.\\config", ".git \\hooks\\pre-commit", ".env::$DATA", "GIT~1\\config", "GITHUB~1\\workflows\\ci.yml", "SSH~1\\id_rsa", "ENV~1.LOC"]) {
      expect(isProtectedRelative(rel)).toBe(true)
    }
    expect(isProtectedRelative("src\\gitlab\\x.ts")).toBe(false)
    expect(isProtectedRelative("GITHUB~1\\README.md")).toBe(false) // only .github/workflows is protected
  })
  test("case differences and drive letters on a win32 path", () => {
    expect(isProtectedPath("C:\\Proj", "c:\\proj\\.GIT\\config", "win32")).toBe(true)
    expect(isProtectedPath("C:\\Proj", "D:\\other\\.git\\config", "win32")).toBe(false)
  })
  test("a junction into .git is caught through the real-path lookup", () => {
    const real = (file: string) => (file.toLowerCase().startsWith("c:\\proj\\docs") ? file.replace(/docs/i, ".git") : file)
    expect(isProtectedPath("C:\\Proj", "C:\\Proj\\docs\\config", "win32", real)).toBe(true)
    expect(isProtectedPath("C:\\Proj", "C:\\Proj\\src\\a.ts", "win32", real)).toBe(false)
  })

  // The Windows CLI smoke (scripts/ci/smoke-cli-windows.ts) plans a write to <project>\.git\config on purpose, in a temp folder with
  // spaces and an 8.3 short user name. The planned path must be seen as protected, written the way exec reports it, and nothing
  // next to it may be.
  test("the CI smoke project: spaces, a RUNNER~1 temp prefix and a .git\\config target", () => {
    const project = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ezk-windows-cli-85zlaw\\ezk windows smoke project"
    expect(isProtectedPath(project, project + "\\.git\\config", "win32")).toBe(true)
    expect(isProtectedPath(project, project + "\\windows-smoke.txt", "win32")).toBe(false)
    expect(isProtectedRelative(".git\\config")).toBe(true)
    expect(isProtectedRelative("windows-smoke.txt")).toBe(false)
  })
})

describe("exec permission decisions for the Windows smoke plan", () => {
  // "full" answers once for ordinary edits in a trusted folder, but never for protected paths, and never in an untrusted folder.
  test("trusted folder: edit allowed, .git\\config denied", () => {
    expect(decidePermission("full", "edit", { patterns: ["windows-smoke.txt"], trusted: true })).toBe("once")
    expect(decidePermission("full", "edit", { patterns: [".git\\config"], trusted: true })).toBe("reject")
  })
  test("untrusted folder: every request is denied, which is what a smoke that skips `ezkielyna trust` runs into", () => {
    expect(decidePermission("full", "edit", { patterns: ["windows-smoke.txt"], trusted: false })).toBe("reject")
    expect(decidePermission("full", "bash", { patterns: ["powershell.exe -NoProfile -Command Write-Output ok"], trusted: false })).toBe("reject")
  })
})

describe("path rules are case-insensitive on Windows", () => {
  const rules: Rule[] = [{ action: "deny", permission: "edit", specifier: "Secrets/**", raw: "Edit(Secrets/**)", source: "test" }]
  const real = process.platform
  test("SECRETS/x.txt matches Secrets/** only when the platform is win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      expect(evaluateRules(rules, { permission: "edit", pattern: "SECRETS/x.txt", root: "C:\\Proj" })).toBeDefined()
    } finally {
      Object.defineProperty(process, "platform", { value: real })
    }
    if (real !== "win32" && real !== "darwin") expect(evaluateRules(rules, { permission: "edit", pattern: "SECRETS/x.txt" })).toBeUndefined()
  })
})

describe("settings files with a byte-order mark", () => {
  test("stripJsonc drops the BOM so deny rules and hooks are not silently lost", () => {
    expect(JSON.parse(stripJsonc('\uFEFF{"permissions":{"deny":["Bash(rm *)"]}}'))).toEqual({ permissions: { deny: ["Bash(rm *)"] } })
  })
})

describe("toolchain probes on Windows", () => {
  test("python (not python3) and no .cmd shim probes", async () => {
    resetSessionStartCache()
    const seen: string[] = []
    await detectToolchain("C:\\no-such-project", {
      platform: "win32",
      trusted: true,
      sessionID: "win",
      exec: async (cmd) => (seen.push(cmd), undefined),
    })
    expect(seen).toContain("python")
    expect(seen).not.toContain("python3")
    expect(seen).not.toContain("npm")
  })
})
