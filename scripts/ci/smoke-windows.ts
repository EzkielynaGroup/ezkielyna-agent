#!/usr/bin/env bun
// Dispatch-only Windows artifact lane. Runs the already built CLI, installer, and desktop artifacts;
// never builds product binaries and never passes inherited credentials to child processes.
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { safeEnv } from "./safe-env"

if (process.platform !== "win32") {
  console.error("smoke-windows.ts must run on a Windows runner")
  process.exit(2)
}
const artifactDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined
if (!artifactDir) {
  console.error("usage: bun scripts/ci/smoke-windows.ts <downloaded artifact directory>")
  process.exit(2)
}

const logDir = path.join(artifactDir, "windows-smoke")
const repoRoot = path.resolve(import.meta.dir, "../..")
const temp = await mkdtemp(path.join(tmpdir(), "ezk-windows-ci-"))
const xdgConfig = path.join(temp, "config")
await mkdir(logDir, { recursive: true })
await mkdir(path.join(temp, "local-app-data"), { recursive: true })
await mkdir(path.join(xdgConfig, "ezkielyna"), { recursive: true })
await writeFile(path.join(xdgConfig, "ezkielyna", "ezkielyna.json"), JSON.stringify({ ezk: { router: { policyURL: "" } } }))
const env = {
  ...safeEnv(process.env),
  LOCALAPPDATA: path.join(temp, "local-app-data"),
  XDG_CONFIG_HOME: xdgConfig,
  OPENCODE_CONFIG_DIR: path.join(xdgConfig, "ezkielyna"),
  EZKIELYNA_BASE_URL: "http://127.0.0.1:1/v1",
  EZK_FEATURES: "",
}
const files = await readdir(artifactDir)
const cli = files.find((name) => /^ezkielyna-cli-.+-windows-x64\.exe$/i.test(name))
const stages: {
  name: string
  script?: string
  args: string[]
  timeout: number
  status: "PASS" | "FAIL"
  log: string
  checks: { name: string; status: "PASS" | "FAIL" }[]
  information: string[]
}[] = []

async function stage(name: string, script: string | undefined, args: string[], timeout: number) {
  const log = path.join(logDir, name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".log")
  let status: "PASS" | "FAIL" = "FAIL"
  let output = ""
  try {
    if (!script) throw new Error("required Windows CLI artifact was not found")
    const result = await run([process.execPath, script, ...args], env, repoRoot, timeout)
    output = result.out + result.err
    status = result.code === 0 && !result.timedOut ? "PASS" : "FAIL"
    if (result.timedOut) output += "\nStage exceeded its " + timeout + " ms timeout\n"
    if (result.code !== 0) output += "\nStage exited with code " + result.code + "\n"
  } catch (error) {
    output += String(error) + "\n"
  }
  await writeFile(log, output)
  const checks = output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(PASS|FAIL) (.+)$/)
    return match ? [{ name: match[2]!, status: match[1] as "PASS" | "FAIL" }] : []
  })
  const information = output.split(/\r?\n/).filter((line) =>
    line.startsWith("INFO remaining %APPDATA%") ||
    line.startsWith("INFO remaining %LOCALAPPDATA%") ||
    line.startsWith("INFO shell instructions delivered to model:"),
  )
  stages.push({ name, script, args, timeout, status, log, checks, information })
  console.log(status + " " + name + " (log: " + path.basename(log) + ")")
}

try {
  const cliPath = cli ? path.join(artifactDir, cli) : undefined
  await stage("Windows CLI", cliPath ? "scripts/ci/smoke-cli-windows.ts" : undefined, cliPath ? [cliPath] : [], 5 * 60_000)
  for (const check of ["line-endings", "paths", "default-shell"]) {
    const name = check === "line-endings" ? "Windows CLI CRLF/LF edits" : check === "paths" ? "Windows CLI spaces, non-ASCII and deep path" : "Windows CLI default PowerShell"
    await stage(name, cliPath ? "scripts/ci/smoke-cli-windows.ts" : undefined, cliPath ? [cliPath, check] : [], 5 * 60_000)
  }
  await stage("Signed installer", cliPath ? "scripts/ci/smoke-install-windows.ts" : undefined, cliPath ? [cliPath] : [], 25 * 60_000)
  await stage("Packaged desktop", "scripts/ci/verify_packaged.ts", [artifactDir], 20 * 60_000)
  await stage("Desktop NSIS shortcut, uninstall and first window", "scripts/ci/smoke-nsis-windows.ts", [artifactDir], 25 * 60_000)

  const rows = stages.flatMap((item) => [
    "| " + item.name + " | " + item.status + " | " + path.basename(item.log) + " |",
    ...item.checks.map((check) => "| &nbsp;&nbsp;" + check.name + " | " + check.status + " | " + path.basename(item.log) + " |"),
  ])
  const report = [
    "# Windows artifact smoke",
    "",
    "Dispatch-only verification of the downloaded Windows artifacts. CLI and installer endpoints use loopback fixtures; the desktop check has no credential and is pointed only at loopback.",
    "",
    "| Stage | Result | Log |",
    "|---|---|---|",
    ...rows,
    "",
    ...stages.flatMap((item) => item.information.length ? ["### " + item.name + " — details", "", ...item.information.map((line) => "- " + line), ""] : []),
    "Detailed logs are attached as the windows-smoke-logs artifact.",
    "",
  ].join("\n")
  const reportPath = path.join(logDir, "windows-smoke.md")
  await writeFile(reportPath, report)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report)
  if (stages.some((item) => item.status !== "PASS")) process.exitCode = 1
} finally {
  await rm(temp, { recursive: true, force: true }).catch(() => {})
}

async function run(args: string[], childEnv: Record<string, string>, cwd: string, timeout: number) {
  const proc = Bun.spawn(args, { cwd, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeout)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { out, err, code, timedOut }
}
