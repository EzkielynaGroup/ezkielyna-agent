// Review (cache audit P2): plan/build reminders must be a function of each user message, not only of the newest one, so the
// bytes of earlier user messages never change between turns (a change there re-bills the whole earlier part of the session).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Session } from "../../src/session/session"
import { SessionReminders } from "../../src/session/reminders"

const user = (id: string, agent: string) => ({
  info: { id, role: "user", sessionID: "ses_1", agent, model: { providerID: "p", modelID: "m" }, time: { created: 1 } },
  parts: [{ id: `${id}-t`, messageID: id, sessionID: "ses_1", type: "text", text: `hello ${id}` }],
})
const assistant = (id: string, agent: string) => ({
  info: { id, role: "assistant", sessionID: "ses_1", agent, parentID: "x", time: { created: 1 } },
  parts: [{ id: `${id}-t`, messageID: id, sessionID: "ses_1", type: "text", text: `answer ${id}` }],
})

const apply = (messages: any[], agentName: string) =>
  SessionReminders.apply({ messages, agent: { name: agentName } as any, session: {} as any }).pipe(
    Effect.provideService(RuntimeFlags.Service, { experimentalPlanMode: false } as any),
    Effect.provideService(FSUtil.Service, {} as any),
    Effect.provideService(Session.Service, {} as any),
    Effect.runPromise,
  )

const bytes = (messages: any[]) => JSON.stringify(messages.map((m) => ({ role: m.info.role, parts: m.parts.map((p: any) => p.text ?? "") })))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

describe("plan reminders are prefix-stable across turns", () => {
  test("turn N+1 starts with exactly the bytes of turn N (plan agent)", async () => {
    const turn1 = [user("u1", "plan")]
    const turn2 = [user("u1", "plan"), assistant("a1", "plan"), user("u2", "plan")]
    const turn3 = [...turn2, assistant("a2", "plan"), user("u3", "plan")]
    const one = bytes(await apply(clone(turn1), "plan"))
    const two = bytes(await apply(clone(turn2), "plan"))
    const three = bytes(await apply(clone(turn3), "plan"))
    const prefix = (long: string, short: string) => long.startsWith(short.slice(0, short.length - 2)) // drop the closing "]"
    // the first user message keeps its reminder in every later request
    expect(prefix(two, one.replace(/\]$/, ""))).toBe(true)
    const firstUserTwo = JSON.parse(two)[0]
    expect(firstUserTwo.parts.length).toBe(2)
    expect(JSON.parse(three)[0]).toEqual(firstUserTwo)
    expect(JSON.parse(three)[2]).toEqual(JSON.parse(two)[2]) // the second user message keeps its reminder too
  })

  test("build after plan: the switch note stays on its message in later turns", async () => {
    const history = [user("u1", "plan"), assistant("a1", "plan"), user("u2", "build")]
    const next = [...history, assistant("a2", "build"), user("u3", "build")]
    const two = JSON.parse(bytes(await apply(clone(history), "build")))
    const three = JSON.parse(bytes(await apply(clone(next), "build")))
    expect(two[2].parts.length).toBe(2)
    expect(three[2]).toEqual(two[2])
  })

  test("build-only sessions get no reminder at all", async () => {
    const out = await apply(clone([user("u1", "build"), assistant("a1", "build"), user("u2", "build")]), "build")
    expect(out.every((m: any) => m.parts.length === 1)).toBe(true)
  })

  test("synthetic-only user messages (loop nudges) get no reminder, the real ones keep theirs", async () => {
    const synthetic = (id: string) => {
      const m = user(id, "plan")
      m.parts = m.parts.map((p: any) => ({ ...p, synthetic: true }))
      return m
    }
    const history = [user("u1", "plan"), assistant("a1", "plan"), synthetic("u2"), assistant("a2", "plan"), synthetic("u3")]
    const out = await apply(clone(history), "plan")
    expect(out.map((m: any) => m.parts.length)).toEqual([2, 1, 1, 1, 1])
  })
})
