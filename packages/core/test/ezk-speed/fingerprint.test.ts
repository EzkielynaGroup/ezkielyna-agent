import { describe, expect, test } from "bun:test"
import { FingerprintGuard, fingerprint } from "../../src/ezk/speed/fingerprint"

const base = () => ({
  system: ["You are Ezkielyna.", "Env: linux"],
  tools: { read: { description: "Read a file", inputSchema: { type: "object", properties: { filePath: { type: "string" } } } }, edit: { description: "Edit", inputSchema: { type: "object" } } },
})

describe("fingerprint guard", () => {
  test("identical assembly across turns -> no change", () => {
    const g = new FingerprintGuard()
    expect(g.observe("s1", base())).toBeUndefined()
    for (let i = 0; i < 5; i++) expect(g.observe("s1", base())).toBeUndefined()
  })
  test("system change is detected", () => {
    const g = new FingerprintGuard()
    g.observe("s1", base())
    const p = base()
    p.system[1] = "Env: linux, date 2026-10-21 12:01" // classic cache-buster: a timestamp in the prompt
    expect(g.observe("s1", p)).toEqual({ sessionID: "s1", turn: 2, part: "system" })
  })
  test("tool description or order change is detected", () => {
    const g = new FingerprintGuard()
    g.observe("s1", base())
    const p = base()
    p.tools = { edit: p.tools.edit, read: p.tools.read } as any
    expect(g.observe("s1", p)?.part).toBe("tools")
  })
  test("sessions are independent; change reported once", () => {
    const g = new FingerprintGuard()
    g.observe("a", base())
    g.observe("b", { ...base(), system: ["other"] })
    expect(g.observe("a", base())).toBeUndefined()
    const p = { ...base(), system: ["x"] }
    expect(g.observe("a", p)?.part).toBe("system")
    expect(g.observe("a", p)).toBeUndefined()
  })
  test("hash is stable and sensitive to one byte", () => {
    expect(fingerprint(base()).hash).toBe(fingerprint(base()).hash)
    const p = base()
    p.system[0] += "."
    expect(fingerprint(p).hash).not.toBe(fingerprint(base()).hash)
  })
})
