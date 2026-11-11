// T2 mock-gateway e2e: the real `ezkielyna serve` with EZK_FEATURES=+exec. A dev-server-style command started in turn 1
// is still alive in turn 2, its monitor lines reach the model as an appended reminder (same bytes on the next request),
// and deleting the session kills the process tree. With default flags the tool list has no exec tools.
import { afterEach, expect, test } from "bun:test"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "../ezk/harness"
import type { ExecTasksResponse } from "@opencode-ai/core/ezk/exec/contracts"

const KEY = "test-key-not-real"
const MODEL = "deepseek-v4.1-flash"
let srv: Server | undefined
let gw: ReturnType<typeof startMockGateway> | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const reminders = (body: any) =>
  JSON.stringify(body.messages)
    .match(/<system-reminder>\\nBackground command bg_1.*?<\/system-reminder>/g) ?? []

test.skipIf(process.platform === "win32")(
  "background dev server survives across turns, monitor lines arrive as a reminder, session delete kills it",
  async () => {
    const devServer = "echo 'ready on http://localhost:4321'; i=0; while true; do i=$((i+1)); echo \"request $i\"; sleep 0.3; done"
    gw = startMockGateway({
      models: { [KEY]: [MODEL] },
      script: {
        [MODEL]: [
          { ok: true, tool: { name: "bash", args: { command: devServer, description: "dev server", run_in_background: true, monitor: true, tty: false } } },
          { ok: true, text: "server started" },
          { ok: true, tool: { name: "write_stdin", args: { session_id: "bg_1", yield_time_ms: 300 } } },
          { ok: true, text: "still serving" },
        ],
      },
    })
    srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+exec" } })
    const s = await newSession(srv, { permission: [{ permission: "bash", pattern: "*", action: "allow" }] })

    await prompt(srv, s.id, "start the dev server", MODEL)
    const afterTool = JSON.stringify(gw.requests[1]!.body.messages)
    expect(afterTool).toContain("session_id: bg_1")
    expect(afterTool).toContain("ready on http://localhost:4321")
    expect(gw.requests[0]!.body.tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(["bash", "write_stdin", "exec_list", "exec_stop"]))

    const listed = await srv.api<ExecTasksResponse>("GET", `/ezk/exec?sessionID=${s.id}`)
    expect(listed.enabled).toBe(true)
    expect(listed.tasks).toHaveLength(1)
    expect(listed.tasks[0]!.status).toBe("running")
    const pid = listed.tasks[0]!.pid
    expect(alive(pid)).toBe(true)

    // review round 2 (M-4): routes are scoped to the owning session and POST needs a JSON content-type
    const other = await newSession(srv)
    const id = listed.tasks[0]!.id
    expect(await srv.api<ExecTasksResponse>("GET", "/ezk/exec")).toEqual({ enabled: true, tasks: [] }) // no session: nothing listed
    expect((await srv.api<ExecTasksResponse>("GET", `/ezk/exec?sessionID=${other.id}`)).tasks).toEqual([])
    await expect(srv.api("GET", `/ezk/exec/output?id=${id}`)).rejects.toThrow("400")
    await expect(srv.api("GET", `/ezk/exec/output?id=${id}&sessionID=${other.id}`)).rejects.toThrow("404")
    expect((await srv.api<{ output: string }>("GET", `/ezk/exec/output?id=${id}&sessionID=${s.id}`)).output).toContain("ready on")
    await expect(srv.api("POST", "/ezk/exec/stop", { id })).rejects.toThrow("400")
    await expect(srv.api("POST", "/ezk/exec/stop", { id, sessionID: other.id })).rejects.toThrow("404")
    const plain = await fetch(`${srv.url}/ezk/exec/stop`, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Basic ${Buffer.from("ezkielyna:ezk-local-e2e-only").toString("base64")}` },
      body: JSON.stringify({ id, sessionID: s.id }),
    })
    expect(plain.status).toBe(415)
    expect(alive(pid)).toBe(true)

    await Bun.sleep(1_000)
    await prompt(srv, s.id, "is it still up?", MODEL)
    // lines printed during turn 1 were attached to turn 1's user message on its second request; turn 2 gets the newer
    // ones on its own user message, and the earlier reminder is re-sent with identical bytes (cache-stable history)
    const turn1 = reminders(gw.requests[1]!.body)
    const delivered = reminders(gw.requests[2]!.body)
    expect(delivered.length).toBe(turn1.length + 1)
    expect(delivered.slice(0, turn1.length)).toEqual(turn1)
    expect(delivered.at(-1)).toContain("request ")
    // the poll in turn 2 sees the server is still running
    expect(JSON.stringify(gw.requests[3]!.body.messages)).toContain("Still running (session_id: bg_1)")
    expect(reminders(gw.requests[3]!.body).slice(0, delivered.length)).toEqual(delivered)
    // the system prompt never carries the volatile lines
    expect(gw.requests[2]!.system).not.toContain("Background command")
    expect(alive(pid)).toBe(true)

    await srv.api("DELETE", `/session/${s.id}`)
    const deadline = Date.now() + 8_000
    while (alive(pid) && Date.now() < deadline) await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  },
  120_000,
)

test("default flags: no exec tools and the plain bash schema", async () => {
  gw = startMockGateway({ models: { [KEY]: [MODEL] } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY })
  const s = await newSession(srv)
  await prompt(srv, s.id, "say hi", MODEL)
  const tools = gw.requests[0]!.body.tools as any[]
  const names = tools.map((t) => t.function.name)
  expect(names).not.toContain("write_stdin")
  expect(names).not.toContain("exec_list")
  const bash = tools.find((t) => t.function.name === "bash")!
  expect(Object.keys(bash.function.parameters.properties).sort()).toEqual(["command", "description", "timeout", "workdir"].filter((k) => k in bash.function.parameters.properties).sort())
  expect(bash.function.parameters.properties.yield_time_ms).toBeUndefined()
  expect(bash.function.description).not.toContain("unified exec")
  const listed = await srv.api<ExecTasksResponse>("GET", "/ezk/exec")
  expect(listed).toEqual({ enabled: false, tasks: [] })
}, 120_000)
