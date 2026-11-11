// T2 Monitor: lines become one appended <system-reminder> part on the latest user message, and parts delivered earlier
// are re-attached with identical bytes on later turns (cache rule), never twice.
import { describe, expect, test } from "bun:test"
import type { ExecInfo } from "@opencode-ai/core/ezk/exec/manager"
import { MonitorInbox, type Message } from "../../src/ezk/exec/monitor"

const info = (over: Partial<ExecInfo> = {}): ExecInfo => ({
  id: "bg_1",
  owner: "ses_a",
  command: "bun run dev",
  cwd: "/p",
  pid: 1,
  backend: "pty",
  monitor: true,
  status: "running",
  startedAt: 0,
  lastAttendedAt: 0,
  bytes: 0,
  ...over,
})
const user = (id: string, session = "ses_a"): Message => ({ info: { id, sessionID: session, role: "user" }, parts: [{ id: `${id}_p`, messageID: id, sessionID: session, type: "text", text: "hi" }] })
const assistant = (id: string): Message => ({ info: { id, sessionID: "ses_a", role: "assistant" }, parts: [] })

describe("MonitorInbox", () => {
  test("delivers pending lines once, as a synthetic reminder on the last user message", () => {
    let n = 0
    const inbox = new MonitorInbox(() => `prt_${++n}`)
    inbox.lines(info(), ["ready on :3000", "GET / 200"])
    const msgs = [user("u1"), assistant("a1")]
    expect(inbox.inject(msgs)).toEqual(["bg_1"])
    const part = msgs[0]!.parts.at(-1)!
    expect(part.synthetic).toBe(true)
    expect(part.text).toBe("<system-reminder>\nBackground command bg_1 (`bun run dev`) printed:\nready on :3000\nGET / 200\n</system-reminder>")
    expect(inbox.inject(msgs)).toEqual([])
    expect(msgs[0]!.parts.length).toBe(2)
  })

  test("re-attaches delivered parts with the same bytes when history is reloaded", () => {
    let n = 0
    const inbox = new MonitorInbox(() => `prt_${++n}`)
    inbox.lines(info(), ["one"])
    const first = [user("u1")]
    inbox.inject(first)
    const reloaded = [user("u1"), assistant("a1"), user("u2")]
    inbox.lines(info(), ["two"])
    inbox.inject(reloaded)
    expect(reloaded[0]!.parts.at(-1)).toEqual(first[0]!.parts.at(-1)!)
    expect(reloaded[2]!.parts.at(-1)!.text).toContain("two")
    expect(reloaded[2]!.parts.at(-1)!.text).not.toContain("one")
  })

  test("caps pending lines and reports the exit", () => {
    const inbox = new MonitorInbox(() => "prt")
    inbox.lines(info(), Array.from({ length: 250 }, (_, i) => `line ${i}`))
    inbox.exited(info({ status: "exited", exitCode: 1 }))
    const msgs = [user("u1")]
    inbox.inject(msgs)
    const text = msgs[0]!.parts.at(-1)!.text!
    expect(text).toContain("line 249")
    expect(text).not.toContain("line 209\n")
    expect(text).toContain("(210 earlier lines not shown")
    expect(text).toContain("It has exited with code 1.")
  })

  test("lines of one session never reach another", () => {
    const inbox = new MonitorInbox(() => "prt")
    inbox.lines(info({ owner: "ses_b" }), ["secret"])
    const msgs = [user("u1", "ses_a")]
    expect(inbox.inject(msgs)).toEqual([])
    expect(inbox.has("ses_b")).toBe(true)
    inbox.forget("ses_b")
    expect(inbox.has("ses_b")).toBe(false)
  })
})
