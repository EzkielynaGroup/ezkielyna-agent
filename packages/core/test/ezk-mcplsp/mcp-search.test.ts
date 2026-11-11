import { describe, expect, test } from "bun:test"
import { bm25, tokenize } from "../../src/ezk/mcp/bm25"
import { buildSearchTools, estimateTokens, metaTokens, planDeferral, totalTokens } from "../../src/ezk/mcp/search-defer"
import { isAlwaysLoad, parseMcpSettings, callTimeoutFor, MCP_DEFAULTS } from "../../src/ezk/mcp/settings"
import { speedEnabled } from "../../src/ezk/speed/flags"
import { threeServers } from "./mock-mcp"

describe("bm25", () => {
  test("tokenize splits snake/camel and stems", () => {
    expect(tokenize("createPullRequest_labels")).toEqual(["create", "pull", "request", "label"])
  })
  test("name match beats description mention", () => {
    const hits = bm25(
      [
        { id: "a", name: "create_issue", description: "Open a new ticket" },
        { id: "b", name: "list_branches", description: "Shows branches; an issue is not required" },
        { id: "c", name: "get_row", description: "database" },
      ],
      "create issue",
    )
    expect(hits[0]!.id).toBe("a")
    expect(hits.find((h) => h.id === "c")).toBeUndefined()
  })
  test("empty query and no docs", () => {
    expect(bm25([], "x")).toEqual([])
    expect(bm25([{ id: "a", name: "a" }], "   ")).toEqual([])
  })
})

describe("planDeferral", () => {
  const tools = threeServers()
  test("120 tools exist and cost real tokens", () => {
    expect(Object.keys(tools).length).toBe(120)
    expect(totalTokens(tools)).toBeGreaterThan(10_000)
  })
  test("below the 10% threshold nothing is deferred", () => {
    expect(planDeferral(tools, { contextTokens: 1_000_000 })).toBeUndefined()
  })
  test("unknown context size never defers", () => {
    expect(planDeferral(tools, { contextTokens: 0 })).toBeUndefined()
  })
  test("above the threshold everything but alwaysLoad servers is deferred", () => {
    const s = parseMcpSettings({ alwaysLoad: ["github"] })
    const plan = planDeferral(tools, {
      contextTokens: 100_000,
      alwaysLoad: (server) => isAlwaysLoad(s, server ?? ""),
    })!
    expect(plan).toBeDefined()
    expect(Object.keys(plan.loaded).length).toBe(40)
    expect(Object.keys(plan.loaded).every((k) => k.startsWith("github_"))).toBe(true)
    expect(Object.keys(plan.deferred).length).toBe(80)
  })
  test("all servers alwaysLoad -> no deferral", () => {
    expect(planDeferral(tools, { contextTokens: 100_000, alwaysLoad: () => true })).toBeUndefined()
  })
})

describe("tool_search + mcp_call", () => {
  const tools = threeServers()
  const [search, call] = buildSearchTools(tools)
  test("names", () => {
    expect(search!.name).toBe("tool_search")
    expect(call!.name).toBe("mcp_call")
  })
  test("index is stable across builds (cache)", () => {
    expect(buildSearchTools(threeServers())[1]!.description).toBe(call!.description)
  })
  test("query loads full schemas of the best matches", async () => {
    const out: string = await search!.run({ query: "create jira ticket", limit: 3 }, {})
    expect(out).toContain("jira_create_ticket")
    expect(out).toContain('"type":"object"')
    expect(out.split("\nschema:").length - 1).toBe(3)
  })
  test("exact names and unknown names", async () => {
    const out: string = await search!.run({ names: ["github_get_issue", "nope"] }, {})
    expect(out).toContain("github_get_issue")
    expect(out).toContain("nope: unknown tool")
  })
  test("no args returns the index", async () => {
    expect(await search!.run({}, {})).toContain("- github_get_issue")
  })
  test("mcp_call runs the wrapped tool, accepts string args, rejects unknown", async () => {
    expect(await call!.run({ name: "jira_get_ticket", arguments: { id: "7" } }, {})).toEqual({ output: 'jira_get_ticket {"id":"7"}' })
    expect(await call!.run({ name: "jira_get_ticket", arguments: '{"id":"8"}' }, {})).toEqual({ output: 'jira_get_ticket {"id":"8"}' })
    expect(await call!.run({ name: "zzz" }, {})).toContain("Unknown MCP tool")
  })
  test("MEASURE prompt tokens: 3 mock servers x 40 tools", () => {
    const full = totalTokens(tools)
    const metas = metaTokens(buildSearchTools(tools))
    const alw = parseMcpSettings({ servers: { github: { alwaysLoad: true } } })
    const plan = planDeferral(tools, { contextTokens: 100_000, alwaysLoad: (s) => isAlwaysLoad(alw, s ?? "") })!
    const withAlways = totalTokens(plan.loaded) + metaTokens(buildSearchTools(plan.deferred))
    const saved = full - metas
    console.log(
      `MCP-TOKENS full=${full} deferred=${metas} saved=${saved} (${((saved / full) * 100).toFixed(1)}%) alwaysLoad(github)=${withAlways} tokens/tool=${Math.round(full / 120)} estimator=chars/4`,
    )
    expect(metas).toBeLessThan(full * 0.25)
    expect(estimateTokens("abcd")).toBe(1)
  })
})

describe("settings and flags", () => {
  test("defaults", () => {
    const s = parseMcpSettings(undefined)
    expect(s).toEqual(MCP_DEFAULTS)
    expect(callTimeoutFor(s, "x")).toBe(60_000)
    expect(s.startupTimeoutMs).toBe(15_000)
    expect(s.maxRestarts).toBe(2)
  })
  test("per-server override and bad values ignored", () => {
    const s = parseMcpSettings({ callTimeoutMs: "x", servers: { db: { callTimeoutMs: 5000, alwaysLoad: true } }, alwaysLoad: ["a", 3] })
    expect(s.callTimeoutMs).toBe(60_000)
    expect(callTimeoutFor(s, "db", 99)).toBe(5000)
    expect(callTimeoutFor(s, "other", 99)).toBe(99)
    expect(isAlwaysLoad(s, "db")).toBe(true)
    expect(isAlwaysLoad(s, "a")).toBe(true)
    expect(isAlwaysLoad(s, "b")).toBe(false)
  })
  test("flag defaults", () => {
    expect(speedEnabled("mcp-robust", {})).toBe(true)
    for (const f of ["mcp-async", "mcp-search", "code-intel"] as const) {
      expect(speedEnabled(f, {})).toBe(false)
      expect(speedEnabled(f, { EZK_FEATURES: `+${f}` })).toBe(true)
    }
    expect(speedEnabled("mcp-robust", { EZK_FEATURES: "-mcp-robust" })).toBe(false)
  })
})
