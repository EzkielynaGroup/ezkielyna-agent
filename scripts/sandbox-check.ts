#!/usr/bin/env bun
// Ezkielyna sandbox check (Linux bubblewrap or macOS Seatbelt): runs the allow/deny matrix through the real sandbox
// and measures the per-command overhead. Used for docs/v3/REPORT-WC-sandbox.md and by scripts/sandbox-smoke-mac.sh.
//
//   bun scripts/sandbox-check.ts [--runs 50] [--json]
//
// Exit 0 when every case matches, 1 on a mismatch, 2 when no sandbox is available here.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { sandboxFor, type Escalation, type SandboxPlan } from "../packages/core/src/ezk/sandbox"

const args = parseArgs({
  options: { runs: { type: "string", default: "50" }, json: { type: "boolean", default: false } },
}).values
const runs = Math.max(1, Number(args.runs) || 50)
const SHELL = "/bin/bash"
const ENV = { ...process.env, EZK_FEATURES: "+sandbox" }

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-sbx-check-")))
const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-sbx-bare-")))
const outside = fs.mkdtempSync(path.join(os.homedir(), ".ezk-sbx-check-outside-"))
fs.mkdirSync(path.join(root, ".git"))
fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n")

const plan = (escalation: Escalation = "use_default", project = root) =>
  sandboxFor("check", "acceptEdits", project, { env: ENV, escalation, shell: SHELL })
const first = plan()
if (!first.wrap) {
  console.error(`no sandbox here: ${first.reason}${first.unavailable ? ` (${first.unavailable})` : ""}`)
  cleanup()
  process.exit(2)
}

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
const net = `curl -sS --max-time 5 http://127.0.0.1:${server.port}/ || (exec 3<>/dev/tcp/127.0.0.1/${server.port})`
const seatbelt = first.kind === "seatbelt"

type Case = { name: string; command: string; escalation?: Escalation; project?: string; expect: "allow" | "deny" }
const cases: Case[] = [
  { name: "write inside the project", command: "echo ok > inside.txt", expect: "allow" },
  {
    name: "write in the temp dir",
    command: `echo ok > ${os.tmpdir()}/ezk-sbx-tmp-$$.txt && rm -f ${os.tmpdir()}/ezk-sbx-tmp-$$.txt`,
    expect: "allow",
  },
  { name: "write outside (home folder)", command: `echo x > ${outside}/x.txt`, expect: "deny" },
  { name: "write ~/.ssh", command: "mkdir -p ~/.ssh && echo x >> ~/.ssh/ezk-sbx-check", expect: "deny" },
  { name: "write .git/config in the project", command: "echo '[x]' >> .git/config", expect: "deny" },
  {
    name: "create .git where it does not exist yet",
    command: "mkdir .git && rmdir .git",
    project: bare,
    expect: seatbelt ? "deny" : "allow",
  },
  {
    name: "read system files, run git",
    command: "cat /etc/hosts >/dev/null && git --version >/dev/null",
    expect: "allow",
  },
  { name: "network (local server)", command: net, expect: "deny" },
  { name: "network after with_network escalation", command: net, escalation: "with_network", expect: "allow" },
  {
    name: "write outside after require_escalated",
    command: `echo x > ${outside}/escalated.txt`,
    escalation: "require_escalated",
    expect: "allow",
  },
]

const rows = []
for (const item of cases) {
  const p = plan(item.escalation, item.project)
  const result = await exec(p, item.command, item.project ?? root)
  const got = result.code === 0 ? "allow" : "deny"
  rows.push({
    ...item,
    got,
    ok: got === item.expect,
    detail: result.output.trim().split("\n").at(-1)?.slice(0, 80) ?? "",
  })
}
server.stop(true)

const overhead = [] as { command: string; plain: Stats; sandboxed: Stats }[]
for (const command of ["true", "ls"]) {
  const plain = time(() => spawnSync(SHELL, ["-c", command], { cwd: root, stdio: "ignore" }))
  const wrapped = time(() =>
    spawnSync(first.wrap![0]!, [...first.wrap!.slice(1), SHELL, "-c", command], { cwd: root, stdio: "ignore" }),
  )
  overhead.push({ command, plain, sandboxed: wrapped })
}
cleanup()

if (args.json)
  console.log(JSON.stringify({ kind: first.kind, platform: process.platform, rows, overhead, runs }, null, 2))
else {
  console.log(`sandbox: ${first.kind} on ${process.platform} ${os.release()} (${os.cpus()[0]?.model ?? "cpu"})\n`)
  console.log("| Case | Expected | Got | |\n|---|---|---|---|")
  for (const row of rows)
    console.log(`| ${row.name} | ${row.expect} | ${row.got} | ${row.ok ? "ok" : `MISMATCH: ${row.detail}`} |`)
  console.log(`\nOverhead over ${runs} runs (ms; median / p95 / mean):\n`)
  console.log("| Command | Plain | Sandboxed | Median overhead |\n|---|---|---|---|")
  for (const row of overhead)
    console.log(
      `| \`${row.command}\` | ${fmt(row.plain)} | ${fmt(row.sandboxed)} | +${(row.sandboxed.median - row.plain.median).toFixed(1)} |`,
    )
}
process.exit(rows.every((row) => row.ok) ? 0 : 1)

async function exec(p: SandboxPlan, command: string, cwd: string) {
  const argv = p.wrap ? [...p.wrap, SHELL, "-c", command] : [SHELL, "-c", command]
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => proc.kill(), 15_000)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, output: out + err }
}

type Stats = { median: number; p95: number; mean: number }
function time(fn: () => unknown): Stats {
  fn() // warm the page cache
  const samples = Array.from({ length: runs }, () => {
    const start = performance.now()
    fn()
    return performance.now() - start
  }).sort((a, b) => a - b)
  return {
    median: samples[Math.floor(samples.length / 2)]!,
    p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]!,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  }
}

function fmt(stats: Stats) {
  return `${stats.median.toFixed(1)} / ${stats.p95.toFixed(1)} / ${stats.mean.toFixed(1)}`
}

function cleanup() {
  for (const dir of [root, bare, outside]) fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(path.join(os.homedir(), ".ssh", "ezk-sbx-check"), { force: true })
}
