// Real bubblewrap: the allow/deny matrix of the Linux sandbox. Skipped where bwrap cannot run (macOS, Windows,
// containers without user namespaces).
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findBwrap, sandboxFor, type Escalation } from "../../src/ezk/sandbox"

const available = process.platform === "linux" && Boolean(findBwrap().path)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-sbx-proj-"))
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-sbx-data-"))
// Outside every writable root: not under the project, the temp dir or the data dir.
const outside = fs.mkdtempSync(path.join(os.homedir(), ".ezk-sbx-outside-"))
fs.mkdirSync(path.join(root, ".git"))
fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n")
fs.mkdirSync(path.join(root, ".ezkielyna"))

afterAll(() => {
  for (const dir of [root, data, outside]) fs.rmSync(dir, { recursive: true, force: true })
})

function run(command: string, escalation: Escalation = "use_default") {
  const plan = sandboxFor(command, "acceptEdits", root, {
    env: { EZK_FEATURES: "+sandbox" },
    extraWritable: [data],
    escalation,
    shell: "/bin/bash",
  })
  if (!plan.wrap) throw new Error(`no sandbox: ${plan.reason} ${plan.unavailable ?? ""}`)
  const result = spawnSync(plan.wrap[0]!, [...plan.wrap.slice(1), "/bin/bash", "-c", command], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  })
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") }
}

describe.skipIf(!available)("bubblewrap sandbox (real)", () => {
  test("write inside the project: allowed", () => {
    expect(run("echo ok > inside.txt && cat inside.txt").code).toBe(0)
    expect(fs.readFileSync(path.join(root, "inside.txt"), "utf8")).toBe("ok\n")
  })

  test("write in the temp dir and the agent data dir: allowed", () => {
    expect(run(`mktemp -p ${os.tmpdir()} >/dev/null && echo x > ${data}/state.txt`).code).toBe(0)
  })

  test("write outside the writable roots: denied, file untouched", () => {
    const result = run(`echo pwned > ${outside}/x.txt`)
    expect(result.code).not.toBe(0)
    expect(result.out).toMatch(/Read-only file system/)
    expect(fs.existsSync(path.join(outside, "x.txt"))).toBe(false)
  })

  test("write .git/config and .ezkielyna inside the project: denied", () => {
    expect(run("echo '[evil]' >> .git/config").code).not.toBe(0)
    expect(fs.readFileSync(path.join(root, ".git", "config"), "utf8")).toBe("[core]\n")
    expect(run("touch .ezkielyna/settings.json").code).not.toBe(0)
  })

  test("reading system files and running tools: allowed", () => {
    expect(run("cat /etc/hostname >/dev/null && ls /usr/bin >/dev/null && git --version").code).toBe(0)
  })

  test("network: denied by default, allowed after with_network escalation", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hi") })
    try {
      const probe = `exec 3<>/dev/tcp/127.0.0.1/${server.port} && echo connected`
      const blocked = await runAsync(probe)
      expect(blocked.code).not.toBe(0)
      const allowed = await runAsync(probe, "with_network")
      expect(allowed.out).toContain("connected")
    } finally {
      server.stop(true)
    }
  })

  test("killing the sandbox kills the command tree", async () => {
    const plan = sandboxFor("sleep 30", "acceptEdits", root, { env: { EZK_FEATURES: "+sandbox" }, shell: "/bin/bash" })
    const proc = Bun.spawn([...plan.wrap!, "/bin/bash", "-c", "sleep 30 & sleep 30; wait"], { cwd: root })
    await Bun.sleep(300)
    proc.kill()
    await proc.exited
    await Bun.sleep(200)
    const left = spawnSync("pgrep", ["-f", "sleep 30"], { encoding: "utf8" }).stdout.trim()
    expect(left).toBe("")
  })
})

// The network test needs the event loop free (the test's own server answers on it), so it spawns asynchronously.
async function runAsync(command: string, escalation: Escalation = "use_default") {
  const plan = sandboxFor(command, "acceptEdits", root, {
    env: { EZK_FEATURES: "+sandbox" },
    escalation,
    shell: "/bin/bash",
  })
  const proc = Bun.spawn([...plan.wrap!, "/bin/bash", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 10_000)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, out: out + err }
}
