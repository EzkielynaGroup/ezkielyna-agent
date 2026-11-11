// Unified exec (T2): bounded buffer, process-tree kill (real on macOS/Linux, simulated Windows), the manager with real
// processes (dev-server kept alive, interactive stdin through a PTY and through pipes), limits and the idle reaper.
import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { HeadTailBuffer } from "../../src/ezk/exec/buffer"
import { descendants, killTree, alive } from "../../src/ezk/exec/process-tree"
import { shellArgv } from "../../src/ezk/exec/backend"
import { ExecLimitError, ExecManager, ExecNotFoundError, clampYield, stripAnsi } from "../../src/ezk/exec/manager"
import { execEnabled } from "../../src/ezk/exec/flags"

const posix = process.platform !== "win32"
const managers: ExecManager[] = []
const make = (options: ConstructorParameters<typeof ExecManager>[0] = {}) => {
  const manager = new ExecManager(options)
  managers.push(manager)
  return manager
}
afterEach(() => {
  managers.splice(0).forEach((manager) => manager.clear())
})

const sh = (command: string) => ({ ...shellArgv("/bin/sh", command), command, cwd: process.cwd(), env: { ...(process.env as Record<string, string>) } })

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(25)
  }
}

describe("flags", () => {
  test("defaults: exec and statusline off, exec-cli and diagnostics on", () => {
    expect(execEnabled("exec", {})).toBe(false)
    expect(execEnabled("statusline", {})).toBe(false)
    expect(execEnabled("exec-cli", {})).toBe(true)
    expect(execEnabled("diagnostics", {})).toBe(true)
  })
  test("EZK_FEATURES toggles", () => {
    const env = { EZK_FEATURES: "+exec, -exec-cli,statusline" }
    expect(execEnabled("exec", env)).toBe(true)
    expect(execEnabled("exec-cli", env)).toBe(false)
    expect(execEnabled("statusline", env)).toBe(true)
  })
})

describe("HeadTailBuffer", () => {
  test("keeps everything under the limit", () => {
    const buf = new HeadTailBuffer(100)
    buf.write("hello ")
    buf.write("world")
    expect(buf.slice()).toEqual({ text: "hello world", end: 11, omitted: 0 })
    expect(buf.slice(6).text).toBe("world")
    expect(buf.slice(11).text).toBe("")
  })

  test("drops the middle with a marker and never stores more than the limit", () => {
    const buf = new HeadTailBuffer(20)
    buf.write("HEADHEADHE")
    for (let i = 0; i < 100; i++) buf.write(`m${i % 10}`)
    buf.write("TAILTAILTA")
    expect(buf.stored).toBeLessThanOrEqual(20)
    const all = buf.slice()
    expect(all.text.startsWith("HEADHEADHE")).toBe(true)
    expect(all.text.endsWith("TAILTAILTA")).toBe(true)
    expect(all.omitted).toBe(200)
    expect(all.text).toContain("[… 200 bytes omitted …]")
  })

  test("incremental reads only return new output, with the gap reported", () => {
    const buf = new HeadTailBuffer(20)
    buf.write("0123456789")
    const first = buf.slice()
    buf.write("x".repeat(50))
    buf.write("END")
    const next = buf.slice(first.end)
    expect(next.text.endsWith("END")).toBe(true)
    expect(next.omitted).toBe(43)
    expect(next.text.startsWith("\n[… 43 bytes omitted …]")).toBe(true)
  })

  test("1 MiB default bound holds for 5 MiB of output", () => {
    const buf = new HeadTailBuffer()
    const chunk = "y".repeat(64 * 1024)
    for (let i = 0; i < 80; i++) buf.write(chunk)
    expect(buf.total).toBe(80 * 64 * 1024)
    expect(buf.stored).toBe(1024 * 1024)
  })

  test("cuts inside multi-byte characters do not produce replacement characters", () => {
    const buf = new HeadTailBuffer(9)
    buf.write("ééééééééé")
    expect(buf.slice().text).not.toContain("\uFFFD")
  })
})

describe("stripAnsi / clampYield", () => {
  test("removes colours, OSC titles and progress-bar carriage returns", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m\r\n\x1b]0;title\x07 10%\r 50%\r100%\ndone")).toBe("ok\n100%\ndone")
  })
  test("yield is clamped to [250 ms, 120 s]", () => {
    expect(clampYield(1)).toBe(250)
    expect(clampYield(10_000)).toBe(10_000)
    expect(clampYield(10_000_000)).toBe(120_000)
    expect(clampYield(Number.NaN)).toBe(250)
  })
})

describe("process tree", () => {
  test("simulated Windows uses taskkill /T /F and never signals a group", () => {
    const calls: [string, string[]][] = []
    const kills: number[] = []
    killTree(4242, {
      platform: "win32",
      run: (file, args) => (calls.push([file, args]), { status: 0, stdout: "" }),
      kill: (pid) => kills.push(pid),
    })
    expect(calls).toEqual([["taskkill.exe", ["/PID", "4242", "/T", "/F"]]])
    expect(kills).toEqual([])
  })

  test("simulated macOS/Linux signals the group and every descendant from ps", () => {
    const ps = " 10 1\n 11 10\n 12 11\n 13 10\n 99 1\n"
    expect(descendants(10, () => ({ status: 0, stdout: ps })).sort()).toEqual([11, 12, 13])
    const kills: [number, string | number][] = []
    killTree(10, { platform: "darwin", signal: "SIGKILL", run: () => ({ status: 0, stdout: ps }), kill: (pid, sig) => kills.push([pid, sig]) })
    expect(kills.map((k) => k[0]).sort((a, b) => a - b)).toEqual([-10, 10, 11, 12, 13])
    expect(new Set(kills.map((k) => k[1]))).toEqual(new Set(["SIGKILL"]))
  })

  test.skipIf(!posix)("real tree: children and a setsid grandchild are killed", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 300 & (setsid sleep 301 2>/dev/null || sleep 301) & echo started; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()))
    await Bun.sleep(100)
    const tree = descendants(child.pid!)
    expect(tree.length).toBeGreaterThanOrEqual(2)
    killTree(child.pid!, { signal: "SIGKILL" })
    await until(() => [child.pid!, ...tree].every((pid) => !alive(pid)))
  })
})

describe.skipIf(!posix)("ExecManager with real processes", () => {
  test("dev-server-style process: returns after the yield, stays alive across reads, stop kills the tree", async () => {
    const m = make()
    const info = await m.start({ owner: "ses_1", ...sh("echo 'listening on :3000'; while true; do sleep 0.1; echo tick; done"), tty: false })
    const first = await m.wait(info.id, { yieldMs: 400 })
    expect(first.status).toBe("running")
    expect(first.output).toContain("listening on :3000")
    expect(first.wallMs).toBeGreaterThanOrEqual(350)
    const second = await m.wait(info.id, { yieldMs: 400 })
    expect(second.status).toBe("running")
    expect(second.output).toContain("tick")
    expect(second.output).not.toContain("listening")
    const tree = descendants(info.pid)
    m.stop(info.id)
    const done = await m.wait(info.id, { yieldMs: 5_000 })
    expect(done.status).toBe("killed")
    await until(() => [info.pid, ...tree].every((pid) => !alive(pid)))
  })

  test("a short command returns as soon as it exits, with its exit code", async () => {
    const m = make()
    const info = await m.start({ owner: "ses_1", ...sh("echo out; echo err >&2; exit 3"), tty: false })
    const r = await m.wait(info.id, { yieldMs: 10_000 })
    expect(r.status).toBe("exited")
    expect(r.exitCode).toBe(3)
    expect(r.output).toContain("out")
    expect(r.output).toContain("err")
    expect(r.wallMs).toBeLessThan(5_000)
  })

  for (const tty of [true, false]) {
    test(`interactive stdin (read prompt) through ${tty ? "a PTY" : "pipes"}`, async () => {
      const m = make()
      const info = await m.start({ owner: "ses_1", ...shellArgv("/bin/bash", 'read -p "name? " n; echo "got:$n"'), command: "read", cwd: process.cwd(), env: process.env as Record<string, string>, tty })
      expect(info.backend).toBe(tty ? "pty" : "pipes")
      // PTY start-up is slow when the machine is busy: keep reading (each wait returns only the NEW output) until the prompt shows
      let prompt = await m.wait(info.id, { yieldMs: 1_000 })
      let seen = prompt.output
      for (let i = 0; i < 12 && tty && !seen.includes("name?") && prompt.status === "running"; i++) {
        prompt = await m.wait(info.id, { yieldMs: 1_000 })
        seen += prompt.output
      }
      expect(prompt.status).toBe("running")
      if (tty) expect(seen).toContain("name?")
      const answer = await m.write(info.id, "bob\n", { yieldMs: 3_000 })
      expect(answer.output).toContain("got:bob")
      expect(answer.status).toBe("exited")
      expect(answer.exitCode).toBe(0)
    }, 30_000)
  }

  test("monitor streams complete lines to listeners", async () => {
    const m = make()
    const seen: string[] = []
    m.onMonitor((info, lines) => info.owner === "ses_m" && seen.push(...lines))
    const info = await m.start({ owner: "ses_m", ...sh("echo one; echo two; printf three"), tty: false, monitor: true })
    await m.wait(info.id, { yieldMs: 5_000 })
    await until(() => seen.length === 3)
    expect(seen).toEqual(["one", "two", "three"])
  })

  test("at most N live processes; finished ones do not count", async () => {
    const m = make({ maxProcesses: 2 })
    const a = await m.start({ owner: "s", ...sh("sleep 30"), tty: false })
    await m.start({ owner: "s", ...sh("sleep 30"), tty: false })
    await expect(m.start({ owner: "s", ...sh("sleep 30"), tty: false })).rejects.toBeInstanceOf(ExecLimitError)
    m.stop(a.id)
    await m.wait(a.id, { yieldMs: 5_000 })
    await m.start({ owner: "s", ...sh("true"), tty: false })
  })

  test("stopOwner only stops that session's processes", async () => {
    const m = make()
    const mine = await m.start({ owner: "a", ...sh("sleep 30"), tty: false })
    const other = await m.start({ owner: "b", ...sh("sleep 30"), tty: false })
    m.stopOwner("a")
    expect((await m.wait(mine.id, { yieldMs: 5_000 })).status).toBe("killed")
    expect(m.get(other.id)!.status).toBe("running")
  })
})

describe("ExecManager with a fake spawner", () => {
  function fake() {
    const procs: { pid: number; data: (d: string) => void; exit: (code: number) => void; written: string[] }[] = []
    const killed: [number, string][] = []
    const spawner = async () => {
      let data = (_: string) => {}
      let exit = (_: { exitCode: number }) => {}
      const p = { pid: 1000 + procs.length, written: [] as string[], data: (d: string) => data(d), exit: (code: number) => exit({ exitCode: code }) }
      procs.push(p)
      return {
        backend: "pipes" as const,
        proc: {
          pid: p.pid,
          onData: (l: (d: string) => void) => ((data = l), { dispose() {} }),
          onExit: (l: (e: { exitCode: number }) => void) => ((exit = l), { dispose() {} }),
          write: (d: string) => p.written.push(d),
          resize() {},
          kill() {},
        },
      }
    }
    return { procs, killed, spawner }
  }

  test("idle reaper stops processes unattended for 30 minutes, not attended ones", async () => {
    let now = 1_000_000
    const f = fake()
    const m = make({ spawn: f.spawner, now: () => now, kill: (pid, sig) => f.killed.push([pid, sig]) })
    const idle = await m.start({ owner: "s", command: "a", file: "x", args: [], cwd: "/", env: {} })
    const busy = await m.start({ owner: "s", command: "b", file: "x", args: [], cwd: "/", env: {} })
    now += 29 * 60_000
    m.touch(busy.id)
    expect(m.reap(now)).toEqual([])
    now += 60_000
    const reaped = m.reap(now)
    expect(reaped.map((r) => r.id)).toEqual([idle.id])
    expect(f.killed).toEqual([[idle.pid, "SIGTERM"]])
  })

  test("unknown ids give an actionable error", async () => {
    const m = make({ spawn: fake().spawner })
    await expect(m.wait("bg_404")).rejects.toBeInstanceOf(ExecNotFoundError)
    expect(() => m.stop("bg_404")).toThrow(/exec_list/)
  })

  test("stopAll kills every running process synchronously (exit hook path)", async () => {
    const f = fake()
    const m = make({ spawn: f.spawner, kill: (pid, sig) => f.killed.push([pid, sig]) })
    const a = await m.start({ owner: "s", command: "a", file: "x", args: [], cwd: "/", env: {} })
    const b = await m.start({ owner: "t", command: "b", file: "x", args: [], cwd: "/", env: {} })
    f.procs[1]!.exit(0)
    m.stopAll()
    expect(f.killed).toEqual([[a.pid, "SIGKILL"]])
    expect(m.get(b.id)!.status).toBe("exited")
  })

  test("finished entries are pruned to keepFinished", async () => {
    const f = fake()
    const m = make({ spawn: f.spawner, keepFinished: 2 })
    for (let i = 0; i < 5; i++) {
      await m.start({ owner: "s", command: String(i), file: "x", args: [], cwd: "/", env: {} })
      f.procs[i]!.exit(0)
    }
    expect(m.list().map((i) => i.command)).toEqual(["3", "4"])
  })
})

describe("shellArgv", () => {
  test("posix, PowerShell and cmd forms", () => {
    expect(shellArgv("/bin/zsh", "ls")).toEqual({ file: "/bin/zsh", args: ["-c", "ls"] })
    expect(shellArgv("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "ls", "win32").args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "ls"])
    expect(shellArgv("C:\\Windows\\System32\\cmd.exe", "dir", "win32").args).toEqual(["/d", "/s", "/c", "dir"])
  })
})
