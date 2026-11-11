#!/usr/bin/env bun
/**
 * Source-server idle RSS regression check. Run from this worktree while holding
 * the shared .heavy.lock in the foreground. Default: 3 samples at stable idle
 * (180 seconds); --full also reports the 8- and 60-second warmup points.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const workspaceRoot = resolve(repoRoot, "..")
const lockPath = resolve(workspaceRoot, ".heavy.lock")
const baselinePath = resolve(import.meta.dir, "perf-idle-baseline.json")
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as {
  samples: number
  pointsSeconds: number[]
  gatePointSeconds: number
  medianRssMiB: Record<string, number>
  maxIncreasePercent: number
}

function requireForegroundLock() {
  const owner = fs.readFileSync(path.join(lockPath, "owner"), "utf8").trim().split(/\s+/)
  const pid = Number(owner.at(-1))
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Missing valid foreground lock owner in ${lockPath}/owner`)
  try {
    process.kill(pid, 0)
  } catch {
    throw new Error(`Foreground lock owner PID ${pid} is not running`)
  }
}

function freeMemoryPercent() {
  const result = Bun.spawnSync(["memory_pressure", "-Q"])
  if (result.exitCode !== 0) throw new Error("memory_pressure -Q failed")
  const match = result.stdout.toString().match(/System-wide memory free percentage:\s*(\d+)%/)
  if (!match) throw new Error("Could not parse memory_pressure -Q output")
  return Number(match[1])
}

function rssKiB(pid: number): number {
  const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)])
  if (result.exitCode !== 0) throw new Error(`Could not read RSS for server PID ${pid}`)
  const rss = Number(result.stdout.toString().trim())
  if (!Number.isFinite(rss) || rss <= 0) throw new Error(`Server PID ${pid} exited before RSS could be read`)
  return rss
}

async function runSample(sample: number, points: number[]) {
  const free = freeMemoryPercent()
  if (free < 40) throw new Error(`Need at least 40% free memory before a sample; observed ${free}%`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-perf-idle-home-"))
  for (const dir of [".config", ".local/share", ".cache"]) fs.mkdirSync(path.join(home, dir), { recursive: true })
  const port = 42_000 + Math.floor(Math.random() * 16_000)

  const bunPath = process.execPath
  const child = Bun.spawn(
    [
      "/bin/bash", "-c", 'LOG_DIR=$1; shift; exec nice -n 10 env "$@" > "$LOG_DIR/stdout.log" 2> "$LOG_DIR/stderr.log"', "perf-idle", home,
      `PATH=${path.dirname(bunPath)}:${process.env.PATH ?? ""}`,
      "NODE_OPTIONS=--max-old-space-size=2048",
      `HOME=${home}`,
      `XDG_CONFIG_HOME=${path.join(home, ".config")}`,
      `XDG_DATA_HOME=${path.join(home, ".local/share")}`,
      `XDG_CACHE_HOME=${path.join(home, ".cache")}`,
      "EZK_SERVER_PASSWORD=perf-idle-local-only",
      bunPath, "run", "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port),
    ],
    {
      cwd: resolve(repoRoot, "packages/opencode"),
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  )

  const readings: Record<number, number> = {}
  let elapsed = 0
  let complete = false
  try {
    // Do not let a bind failure, startup error or a stale server on port 40081
    // turn into a deceptively small RSS sample. Wait for this process to serve
    // its health endpoint before starting the idle clock.
    let ready = false
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        process.kill(child.pid, 0)
        const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
          headers: { authorization: `Basic ${Buffer.from("ezkielyna:perf-idle-local-only").toString("base64")}` },
          signal: AbortSignal.timeout(1000),
        })
        if (response.ok && (await response.json() as { healthy?: unknown }).healthy === true) {
          ready = true
          break
        }
      } catch {
        // Server startup can take a few seconds; retry while its process lives.
      }
      await Bun.sleep(1000)
    }
    if (!ready) throw new Error(`Source server PID ${child.pid} did not become healthy on port ${port}`)

    for (const point of points) {
      await Bun.sleep((point - elapsed) * 1000)
      try {
        process.kill(child.pid, 0)
      } catch {
        throw new Error(`Server PID ${child.pid} exited before ${point}s; check the captured server logs and local bind permissions`)
      }
      readings[point] = Math.round(rssKiB(child.pid) / 1024)
      console.log(`sample ${sample}/${baseline.samples}, t=${point}s, RSS=${readings[point]} MiB, free=${free}%`)
      elapsed = point
    }
    complete = true
  } finally {
    child.kill("SIGTERM")
    const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)])
    if (!stopped) {
      child.kill("SIGKILL")
      await child.exited
    }
    if (!complete) {
      for (const name of ["stderr.log", "stdout.log"]) {
        const file = path.join(home, name)
        if (!fs.existsSync(file)) continue
        const log = fs.readFileSync(file, "utf8").trim()
        if (log) console.error(`${name} (last 6000 chars):\n${log.slice(-6000)}`)
      }
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
  return readings
}

function median(values: number[]) {
  const ordered = values.toSorted((a, b) => a - b)
  return ordered[Math.floor(ordered.length / 2)]!
}

async function main() {
  requireForegroundLock()
  const points = process.argv.includes("--full")
    ? baseline.pointsSeconds
    : [baseline.gatePointSeconds]
  const values = new Map(points.map((point) => [point, [] as number[]]))
  for (let sample = 1; sample <= baseline.samples; sample++) {
    const reading = await runSample(sample, points)
    for (const point of points) values.get(point)!.push(reading[point]!)
  }

  let failed = false
  for (const point of points) {
    const actual = median(values.get(point)!)
    const expected = baseline.medianRssMiB[String(point)]
    const limit = Math.ceil(expected * (1 + baseline.maxIncreasePercent / 100))
    const gate = point === baseline.gatePointSeconds
    console.log(`median t=${point}s${gate ? " [gate]" : " [warmup]"}: ${actual} MiB (baseline ${expected} MiB, limit ${limit} MiB)`)
    if (gate && actual > limit) failed = true
  }
  if (failed) process.exitCode = 1
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
