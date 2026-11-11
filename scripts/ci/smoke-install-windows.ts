#!/usr/bin/env bun
// Exercises the real install.ps1 against locally served, signed fixtures. A throwaway
// P-256 key is generated in memory; only its public key is written into a temporary copy.
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { safeEnv } from "./safe-env"

const binary = process.argv[2] ? path.resolve(process.argv[2]) : undefined
if (process.platform !== "win32") {
  console.error("smoke-install-windows.ts must run on a Windows runner")
  process.exit(2)
}
if (!binary || !(await Bun.file(binary).exists())) {
  console.error("usage: bun scripts/ci/smoke-install-windows.ts <path to ezkielyna.exe>")
  process.exit(2)
}

const failures: string[] = []
const temp = await mkdtemp(path.join(tmpdir(), "ezk-installer-smoke-"))
const sourceDir = path.join(temp, "payload")
const localAppData = path.join(temp, "local-app-data")
const installRoot = path.join(localAppData, "Ezkielyna")
const binDir = path.join(installRoot, "bin")
const installerPath = path.join(temp, "install-test.ps1")
const originalScript = await readFile(path.resolve(import.meta.dir, "../../install.ps1"), "utf8")
const pinnedKey = originalScript.match(/\$PubB64 = '([^']+)'/)?.[1]
if (!pinnedKey) throw new Error("could not locate the installer public-key declaration")
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const testPublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64")
const testScript = originalScript.replace("$PubB64 = '" + pinnedKey + "'", "$PubB64 = '" + testPublicKey + "'")
if (testScript === originalScript) throw new Error("temporary public-key replacement did not occur")
await writeFile(installerPath, testScript)
await mkdir(sourceDir, { recursive: true })
await copyFile(binary, path.join(sourceDir, "ezkielyna.exe"))

const zip = path.join(temp, "fixture.zip")
const zipRun = await run("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
  "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Compress-Archive -Path " + ps(sourceDir + "\\*") + " -DestinationPath " + ps(zip) + " -Force",
], safeEnv(process.env), temp)
if (zipRun.code !== 0) throw new Error("could not create local installer archive: " + tail(zipRun.out + zipRun.err))
const archive = await readFile(zip)
const keypair = { publicKey, privateKey }
// Real release numbers: the no-downgrade check compares 1.19.3-ezk.N style versions, and a bug there only shows once the minor/patch
// parts are larger than the major part of the new version (19 > 1), which 99.0.0 style fixtures never reach.
const FIRST = "1.19.3-ezk.2"
const UPGRADE = "1.19.3-ezk.5"
let fixture = await makeFixture(FIRST, archive, keypair)
const localServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const name = path.posix.basename(new URL(req.url).pathname)
    const value = fixture.get(name)
    return value ? new Response(value) : new Response("fixture not found", { status: 404 })
  },
})

const childEnv = {
  ...safeEnv(process.env),
  LOCALAPPDATA: localAppData,
  EZK_BASE_URL: "http://127.0.0.1:" + localServer.port,
}
let pathBefore: string | undefined

try {
  pathBefore = await readUserPath()
  const first = await install()
  check(first.code === 0, "install.ps1 installs a fresh locally signed release", detail(first))
  const firstExe = path.join(installRoot, "versions", FIRST, "ezkielyna.exe")
  check(await Bun.file(firstExe).exists(), "versioned CLI executable is installed")
  check(await Bun.file(path.join(binDir, "ezkielyna.cmd")).exists() && await Bun.file(path.join(binDir, "ezk.cmd")).exists(), "both command shims are installed")

  const pathAfter = await readUserPath()
  check(hasPath(pathAfter, binDir), "install.ps1 updates the current user's PATH")
  const freshShell = [
    "$ErrorActionPreference='Stop'",
    "$machine=[Environment]::GetEnvironmentVariable('Path','Machine')",
    "$user=[Environment]::GetEnvironmentVariable('Path','User')",
    "$env:Path=@($machine,$user) -join ';'",
    "$bin=" + ps(binDir),
    "foreach ($name in @('ezkielyna','ezk')) { $shim=Join-Path $bin ($name + '.cmd'); $command=Get-Command ($name + '.cmd') -CommandType Application -ErrorAction Stop; if ($command.Path -ine $shim) { throw ($name + ' resolved outside the installed PATH shim') }; $version=& $name --version 2>&1; if ($LASTEXITCODE -ne 0 -or -not $version) { throw ($name + ' --version failed') }; Write-Output ($name + ': ' + ($version -join ' ')) }",
  ].join("; ")
  const pathShell = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", freshShell,
  ], safeEnv(process.env), temp)
  const aliasVersions = [...pathShell.out.matchAll(/^(ezkielyna|ezk):\s*(\S+)/gim)]
  check(pathShell.code === 0 && aliasVersions.length === 2 && aliasVersions[0]?.[2] === aliasVersions[1]?.[2], "fresh PowerShell resolves both installed PATH shims and --version", detail(pathShell))
  const version = await run(firstExe, ["--version"], safeEnv(process.env), temp)
  check(version.code === 0 && version.out.trim().length > 0, "installed CLI starts and prints its version", detail(version))
  const installedHash = await fileHash(firstExe)

  // Signed but older: refused, and nothing on disk changes.
  for (const older of ["1.19.3-ezk.1", "1.18.9"]) {
    fixture = await makeFixture(older, archive, keypair)
    const downgrade = await install()
    check(downgrade.code !== 0 && /refusing to downgrade/i.test(downgrade.out + downgrade.err), "signed older release " + older + " is refused as a downgrade", detail(downgrade))
    check(!existsSync(path.join(installRoot, "versions", older)), "refused downgrade " + older + " installs nothing")
  }
  check((await fileHash(firstExe)) === installedHash, "downgrade attempts leave installed CLI bytes unchanged")

  // Signed and newer: a genuine upgrade must go through, and the command shims must move to it.
  fixture = await makeFixture(UPGRADE, archive, keypair)
  const upgrade = await install()
  const upgradedExe = path.join(installRoot, "versions", UPGRADE, "ezkielyna.exe")
  check(upgrade.code === 0, "install.ps1 upgrades " + FIRST + " to " + UPGRADE, detail(upgrade))
  check(await Bun.file(upgradedExe).exists(), "upgraded CLI executable is installed")
  check((await readFile(path.join(binDir, "ezkielyna.cmd"), "utf8")).includes(UPGRADE), "command shims point at the upgraded CLI")

  // The older signed release is a downgrade again once the newer one is installed.
  fixture = await makeFixture(FIRST, archive, keypair)
  const replay = await install()
  check(replay.code !== 0 && /refusing to downgrade/i.test(replay.out + replay.err), "replaying the older signed release after the upgrade is refused", detail(replay))

  const runningBefore = await run("tasklist.exe", ["/FI", "IMAGENAME eq ezkielyna.exe", "/FO", "CSV", "/NH"], safeEnv(process.env), temp)
  check(!/"ezkielyna\.exe"/i.test(runningBefore.out), "no CLI process is running before the documented uninstall", runningBefore.out)
  const uninstallDoc = originalScript.match(/To uninstall,[^\r\n]*\r?\n((?:[ \t]{2,}[^\r\n]*(?:\r?\n|$))+)/)?.[1]
  const uninstallCommand = uninstallDoc?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n")
  check(Boolean(uninstallCommand), "install.ps1 documents a runnable PowerShell uninstall command")
  const removed = uninstallCommand
    ? await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", uninstallCommand,
      ], childEnv, temp)
    : { out: "", err: "uninstall command was not found in install.ps1 help", code: 1, timedOut: false, seconds: 0 }
  check(removed.code === 0, "documented CLI uninstall removes the program and PATH entry", detail(removed))
  check(!existsSync(installRoot), "CLI install directory is gone after uninstall")
  check(!hasPath(await readUserPath(), binDir), "uninstall removes the user's CLI PATH entry")
  const runningAfter = await run("tasklist.exe", ["/FI", "IMAGENAME eq ezkielyna.exe", "/FO", "CSV", "/NH"], safeEnv(process.env), temp)
  check(!/"ezkielyna\.exe"/i.test(runningAfter.out), "no ezkielyna.exe remains running after uninstall", runningAfter.out)
} finally {
  localServer.stop(true)
  if (pathBefore !== undefined) await setUserPath(pathBefore)
  await rm(temp, { recursive: true, force: true }).catch(() => {})
}

if (failures.length) process.exit(1)
console.log("Windows installer smoke passed")

// A fresh install downloads, hashes and unzips a ~60 MB archive on a hosted runner with Defender scanning every file, so it gets far more
// than the default 60 s. The seconds are logged so a slow installer shows up in the log before it turns into a timeout.
async function install() {
  const result = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installerPath,
  ], childEnv, temp, 300_000)
  console.log("INFO install.ps1 run took " + result.seconds + " s (exit " + result.code + (result.timedOut ? ", killed on timeout" : "") + ")")
  return result
}

function check(ok: boolean, label: string, evidence = "") {
  if (ok) {
    console.log("PASS " + label)
    return
  }
  console.error("FAIL " + label + (evidence ? "\n" + evidence : ""))
  failures.push(label)
}

async function makeFixture(version: string, zipBytes: Buffer, keys: typeof keypair) {
  const archiveName = "ezkielyna-" + version + "-windows-x64.zip"
  const manifest = Buffer.from(JSON.stringify({ version }))
  const checksums = Buffer.from(createHash("sha256").update(zipBytes).digest("hex") + " *" + archiveName + "\n")
  const files = new Map<string, Buffer>([
    ["latest.json", manifest],
    ["latest.json.sig", sign("sha256", manifest, keys.privateKey)],
    ["SHA256SUMS", checksums],
    ["SHA256SUMS.sig", sign("sha256", checksums, keys.privateKey)],
    [archiveName, zipBytes],
  ])
  return files
}

async function run(command: string, args: string[], env: Record<string, string | undefined>, cwd: string, timeout = 60_000) {
  const started = Date.now()
  const proc = Bun.spawn([command, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeout)
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { out, err, code, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10 }
}

async function readUserPath() {
  const result = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','User') | ConvertTo-Json -Compress",
  ], safeEnv(process.env), temp)
  if (result.code !== 0) throw new Error("could not read current user PATH: " + tail(result.out + result.err))
  const value = result.out.trim()
  return value && value !== "null" ? JSON.parse(value) as string : ""
}

async function setUserPath(value: string) {
  const encoded = Buffer.from(value, "utf8").toString("base64")
  await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')); [Environment]::SetEnvironmentVariable('Path',$p,'User')",
  ], safeEnv(process.env), temp)
}

function hasPath(value: string, entry: string) {
  const norm = (item: string) => item.trim().replace(/[\\/]+$/, "").toLowerCase()
  return value.split(";").some((item) => norm(item) === norm(entry))
}

async function fileHash(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

function ps(value: string) {
  return "'" + value.replace(/'/g, "''") + "'"
}

function detail(result: { code: number; out: string; err: string; timedOut?: boolean; seconds?: number }) {
  const timing = result.seconds === undefined ? "" : (result.timedOut ? " killed after " : " after ") + result.seconds + " s"
  return "exit=" + result.code + timing + "\n" + tail(result.out + result.err)
}

function tail(text: string) {
  return text.slice(-3000)
}
