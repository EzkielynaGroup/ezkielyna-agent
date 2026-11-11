#!/usr/bin/env bun
// Exercises the real NSIS installer and uninstaller on a disposable Windows profile. The first app window is captured via local CDP.
import { existsSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { safeEnv } from "./safe-env"

if (process.platform !== "win32") {
  console.error("smoke-nsis-windows.ts must run on a Windows runner")
  process.exit(2)
}

const artifactDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined
if (!artifactDir) {
  console.error("usage: bun scripts/ci/smoke-nsis-windows.ts <downloaded artifact directory>")
  process.exit(2)
}

const failures: string[] = []
const files = await readdir(artifactDir)
const installer = files.map((name) => path.join(artifactDir, name)).find((file) => /^ezkielyna-agent-.+-(?:win|windows)-x64\.exe$/i.test(path.basename(file)))
const temp = await mkdtemp(path.join(tmpdir(), "ezk-nsis-depth-"))
const appData = path.join(temp, "Roaming")
const localAppData = path.join(temp, "Local")
const installRequest = path.join(temp, "nsis-install")
const userProfile = path.join(temp, "profile")
const logDir = path.join(artifactDir, "windows-smoke")
const screenshot = path.join(logDir, "desktop-first-window.png")
const env = {
  ...safeEnv(process.env),
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  USERPROFILE: userProfile,
  HOME: userProfile,
  EZK_USER_DATA_DIR: path.join(userProfile, "Ezkielyna Agent"),
  EZKIELYNA_BASE_URL: "http://127.0.0.1:1/v1",
  OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  ELECTRON_ENABLE_LOGGING: "1",
  ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
}

try {
  await mkdir(appData, { recursive: true })
  await mkdir(localAppData, { recursive: true })
  await mkdir(userProfile, { recursive: true })
  await mkdir(logDir, { recursive: true })
  check(Boolean(installer), "Windows NSIS installer artifact is present", files.join("\n"))
  if (!installer) throw new Error("required Windows NSIS installer artifact was not found")

  const install = await run(installer, ["/S", `/D=${installRequest}`], env, temp, 300_000)
  check(install.code === 0, "silent NSIS install (/S) completes", detail(install))
  const appDir = await findAppDir(installRequest).catch(() => findAppDir(path.join(localAppData, "Programs"))).catch(() => undefined)
  check(Boolean(appDir), "installed NSIS app directory contains resources/app.asar")

  let installRoot: string | undefined
  let appExe: string | undefined
  let uninstallExe: string | undefined
  if (appDir) {
    installRoot = appDir
    const names = await readdir(appDir).catch(() => [])
    const exe = names.find((name) => /^Ezkielyna Agent(?: Beta| Dev)?\.exe$/i.test(name))
    appExe = exe ? path.join(appDir, exe) : undefined
    uninstallExe = (await findNamedFile(installRoot, "Uninstall Ezkielyna Agent.exe")) ?? undefined
    check(Boolean(appExe && existsSync(appExe)), "installed Ezkielyna Agent executable exists", appDir)
    check(Boolean(uninstallExe && existsSync(uninstallExe)), "NSIS uninstall Ezkielyna Agent.exe is installed", installRoot)
  }

  const shortcutRun = await inspectShortcut(env, temp)
  const shortcut = parseShortcut(shortcutRun.out)
  check(shortcutRun.code === 0 && Boolean(shortcut?.path), 'Start Menu shortcut is named "Ezkielyna Agent"', detail(shortcutRun))
  check(Boolean(shortcut?.target && appExe && samePath(shortcut.target, appExe)), "Start Menu shortcut targets the installed app", JSON.stringify(shortcut))
  const iconFile = shortcut?.icon?.split(",")[0]?.replace(/^"|"$/g, "").trim()
  check(Boolean(iconFile && existsSync(iconFile)), "Start Menu shortcut references the packaged app icon", JSON.stringify(shortcut))

  if (appDir) {
    const desktop = await run(process.execPath, [path.join(import.meta.dir, "smoke-desktop.ts"), appDir], {
      ...env,
      EZK_SMOKE_FIRST_WINDOW_SCREENSHOT: screenshot,
    }, path.resolve(import.meta.dir, "../.."), 20 * 60_000)
    check(desktop.code === 0, "installed desktop starts, its sidecar is healthy, and CDP captures the first window", detail(desktop))
  } else {
    check(false, "installed desktop starts and the first window is captured via CDP", "no app directory was found")
  }
  const png = await Bun.file(screenshot).arrayBuffer().catch(() => undefined)
  check(Boolean(png && new Uint8Array(png).slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"), "CDP screenshot is a PNG attached under windows-smoke-logs", screenshot)

  const processesBeforeUninstall = await runningAppProcesses(temp)
  check(processesBeforeUninstall.code === 0 && !processesBeforeUninstall.out.includes('"Ezkielyna Agent'), "no Ezkielyna Agent process remains after desktop smoke", processesBeforeUninstall.out)
  if (uninstallExe) {
    const uninstall = await run(uninstallExe, ["/S"], env, temp, 180_000)
    check(uninstall.code === 0, "silent NSIS uninstall completes", detail(uninstall))
  } else {
    check(false, "silent NSIS uninstall completes", "uninstaller was not found")
  }

  const removedDeadline = Date.now() + 30_000
  while (installRoot && Date.now() < removedDeadline && existsSync(installRoot)) await Bun.sleep(250)
  check(Boolean(installRoot && !existsSync(installRoot)), "NSIS uninstall removes the installation directory", installRoot ?? "unknown install root")
  const shortcutAfter = await inspectShortcut(env, temp)
  const shortcutAfterState = parseShortcut(shortcutAfter.out)
  check(shortcutAfter.code === 0 && shortcutAfterState !== undefined && !shortcutAfterState.path, "NSIS uninstall removes the Start Menu shortcut", detail(shortcutAfter))
  const processesAfterUninstall = await runningAppProcesses(temp)
  check(processesAfterUninstall.code === 0 && !processesAfterUninstall.out.includes('"Ezkielyna Agent'), "no Ezkielyna Agent process remains after uninstall", processesAfterUninstall.out)

  console.log("INFO remaining %APPDATA% paths (expected user data may remain): " + JSON.stringify(await listPaths(appData)))
  console.log("INFO remaining %LOCALAPPDATA% paths (expected user data may remain): " + JSON.stringify(await listPaths(localAppData)))
} finally {
  await Bun.spawn(["taskkill.exe", "/IM", "Ezkielyna Agent.exe", "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited.catch(() => {})
  await rm(temp, { recursive: true, force: true }).catch(() => {})
}

if (failures.length) process.exit(1)
console.log("Windows NSIS depth smoke passed")

async function inspectShortcut(childEnv: Record<string, string>, cwd: string) {
  const script = [
    "$starts=@((Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique",
    "$file=Get-ChildItem -LiteralPath $starts -Filter 'Ezkielyna Agent.lnk' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if (-not $file) { [pscustomobject]@{path=$null;target=$null;icon=$null} | ConvertTo-Json -Compress; exit 0 }",
    "$shell=New-Object -ComObject WScript.Shell",
    "$shortcut=$shell.CreateShortcut($file.FullName)",
    "[pscustomobject]@{path=$file.FullName;target=$shortcut.TargetPath;icon=$shortcut.IconLocation} | ConvertTo-Json -Compress",
  ].join("; ")
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encodePowerShell(script)], childEnv, cwd)
}

async function runningAppProcesses(cwd: string) {
  return run("tasklist.exe", ["/FI", "IMAGENAME eq Ezkielyna Agent.exe", "/FO", "CSV", "/NH"], safeEnv(process.env), cwd)
}

async function findAppDir(root: string, depth = 0): Promise<string> {
  if (await Bun.file(path.join(root, "resources", "app.asar")).exists()) return root
  if (depth >= 4) throw new Error(`no resources/app.asar under ${root}`)
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const result = await findAppDir(path.join(root, entry.name), depth + 1).catch(() => undefined)
    if (result) return result
  }
  throw new Error(`no resources/app.asar under ${root}`)
}

async function findNamedFile(root: string, name: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return target
    if (entry.isDirectory()) {
      const result = await findNamedFile(target, name)
      if (result) return result
    }
  }
  return null
}

async function listPaths(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => [])
  return (await Promise.all(entries.map(async (entry) => {
    const relative = path.join(prefix, entry.name)
    return entry.isDirectory() ? [relative, ...(await listPaths(root, relative))] : [relative]
  }))).flat().sort().slice(0, 200)
}

function encodePowerShell(script: string) {
  return Buffer.from(script, "utf16le").toString("base64")
}

function parseShortcut(text: string) {
  try {
    return JSON.parse(text.trim()) as { path?: string; target?: string; icon?: string }
  } catch {
    return undefined
  }
}

function samePath(left: string, right: string) {
  // realpath expands 8.3 short names (C:\Users\RUNNER~1 vs C:\Users\runneradmin) before comparing
  const real = (file: string) => {
    try {
      return realpathSync.native(file)
    } catch {
      return file
    }
  }
  return path.win32.normalize(real(left)).toLowerCase() === path.win32.normalize(real(right)).toLowerCase()
}

function check(ok: boolean, label: string, evidence = "") {
  if (ok) {
    console.log("PASS " + label)
    return
  }
  console.error("FAIL " + label + (evidence ? "\n" + evidence : ""))
  failures.push(label)
}

async function run(command: string, args: string[], childEnv: Record<string, string>, cwd: string, timeout = 60_000) {
  const proc = Bun.spawn([command, ...args], { cwd, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeout)
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { out, err, code, timedOut }
}

function detail(result: { code: number; out: string; err: string; timedOut?: boolean }) {
  return `exit=${result.code}${result.timedOut ? " (timeout)" : ""}\n${result.out}${result.err}`.slice(-6000)
}
