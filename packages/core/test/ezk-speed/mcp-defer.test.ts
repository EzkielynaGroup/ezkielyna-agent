import { describe, expect, test } from "bun:test"
import { deferMcpTools } from "../../src/ezk/speed/mcp-defer"
import { speedEnabled } from "../../src/ezk/speed/flags"

const mk = (n: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `srv_tool${i}`,
      {
        description: `Tool number ${i} does something quite specific with a very long description `.repeat(8),
        inputSchema: { jsonSchema: { type: "object", properties: { q: { type: "string", description: "x".repeat(300) } } } },
        execute: async (a: any) => ({ output: `ran ${i} ${JSON.stringify(a)}` }),
      },
    ]),
  )

describe("deferMcpTools", () => {
  test("fewer than the threshold -> not deferred", () => {
    expect(deferMcpTools(mk(3))).toBeUndefined()
  })
  test("index lives in mcp_call description, stable across calls", () => {
    const a = deferMcpTools(mk(6))!
    const b = deferMcpTools(mk(6))!
    expect(a.metaTools.map((t) => t.name)).toEqual(["mcp_describe", "mcp_call"])
    expect(a.metaTools[1]!.description).toBe(b.metaTools[1]!.description)
    expect(a.metaTools[1]!.description).toContain("srv_tool5:")
  })
  test("request size shrinks by >= 50% with 6 tools", () => {
    const tools = mk(6)
    const full = JSON.stringify(Object.entries(tools).map(([k, t]) => [k, t.description, t.inputSchema.jsonSchema])).length
    const d = deferMcpTools(tools)!
    const small = JSON.stringify(d.metaTools.map((t) => [t.name, t.description, t.parameters])).length
    console.log(`mcp-defer bytes: full=${full} deferred=${small} saved=${Math.round((1 - small / full) * 100)}%`)
    expect(small).toBeLessThan(full * 0.5)
  })
  test("describe returns schema on demand; call dispatches to the real tool", async () => {
    const d = deferMcpTools(mk(5))!
    const [describe, call] = d.metaTools
    expect(await describe!.run({ names: ["srv_tool2"] }, {})).toContain('"q"')
    expect(await describe!.run({ names: ["nope"] }, {})).toContain("unknown tool")
    expect((await call!.run({ name: "srv_tool1", arguments: { q: "hi" } }, {})).output).toBe('ran 1 {"q":"hi"}')
    expect((await call!.run({ name: "srv_tool1", arguments: '{"q":"s"}' }, {})).output).toBe('ran 1 {"q":"s"}')
    expect(await call!.run({ name: "missing" }, {})).toContain("Unknown MCP tool")
  })
})

describe("flags", () => {
  test("defaults", () => {
    expect(speedEnabled("tolerant-edit", {})).toBe(true)
    expect(speedEnabled("watchdog", {})).toBe(true)
    expect(speedEnabled("mcp-defer", {})).toBe(false)
  })
  test("kill switch and opt-in", () => {
    const env = { EZK_FEATURES: "-tolerant-edit, -watchdog,+mcp-defer" }
    expect(speedEnabled("tolerant-edit", env)).toBe(false)
    expect(speedEnabled("watchdog", env)).toBe(false)
    expect(speedEnabled("mcp-defer", env)).toBe(true)
  })
})
