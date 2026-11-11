import { describe, expect, test } from "bun:test"
import {
  validateInputs, parseEvents, formatSummary, parseReviewResult, formatReviewComment, upsertComment, MARKER,
  assertSafeBranch, fixBranchName, redact, capDiff, tailLog, makeApi, isProjectConfigPath,
} from "../lib/lib.mjs"

const ok = { mode: "review", apiKey: "k-123456", maxBudget: "", model: "", version: "" }

describe("validateInputs", () => {
  test("defaults per mode", () => {
    const r = validateInputs(ok)
    expect(r.ok).toBe(true)
    expect(r.config).toMatchObject({ model: "ezk-auto", maxBudget: 0.5, permissionMode: "plan", version: "latest" })
    expect(validateInputs({ ...ok, mode: "fix-ci" }).config.permissionMode).toBe("acceptEdits")
  })
  test("rejects bad input", () => {
    expect(validateInputs({ ...ok, apiKey: "" }).errors[0]).toContain("api-key")
    expect(validateInputs({ ...ok, apiKey: "" }, { dryRun: true }).ok).toBe(true)
    expect(validateInputs({ ...ok, mode: "nope" }).ok).toBe(false)
    expect(validateInputs({ ...ok, mode: "custom" }).errors.join()).toContain("prompt")
    expect(validateInputs({ ...ok, maxBudget: "-1" }).ok).toBe(false)
    expect(validateInputs({ ...ok, maxBudget: "abc" }).ok).toBe(false)
    expect(validateInputs({ ...ok, maxBudget: "1000" }).ok).toBe(false)
    expect(validateInputs({ ...ok, maxTurns: "0" }).ok).toBe(false)
    expect(validateInputs({ ...ok, maxTurns: "2.5" }).ok).toBe(false)
    expect(validateInputs({ ...ok, permissionMode: "full" }).ok).toBe(false)
    expect(validateInputs({ ...ok, permissionMode: "x" }).ok).toBe(false)
    expect(validateInputs({ ...ok, model: "a b; rm" }).ok).toBe(false)
    expect(validateInputs({ ...ok, version: "1.2" }).ok).toBe(false)
    expect(validateInputs({ ...ok, version: "1.19.3-ezk.3" }).ok).toBe(true)
  })
})

const events = [
  '{"type":"thread.started","thread_id":"t"}',
  "not json",
  '{"type":"item.completed","item":{"type":"command_execution"}}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"hello | world"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2,"cost_usd":0.5}}',
  '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":1}}',
].join("\n")

describe("summary", () => {
  test("parseEvents", () => {
    const p = parseEvents(events)
    expect(p).toMatchObject({ threadId: "t", turns: 2, commands: 1, result: "hello | world", cost: 0.5 })
    expect(p.usage).toEqual({ input: 15, cached: 4, output: 3 })
  })
  test("formatSummary", () => {
    const md = formatSummary({ mode: "review", model: "ezk-auto", parsed: parseEvents(events), exitCode: 2, outcome: "comment created" })
    expect(md).toContain("| Turns | 2 |")
    expect(md).toContain("$0.5000")
    expect(md).toContain("2 (stopped by max-turns or max-budget)")
    expect(md).toContain("comment created")
    expect(formatSummary({ mode: "custom", model: "m", parsed: parseEvents(""), exitCode: 0 })).toContain("| Cost | n/a |")
  })
})

describe("review comment", () => {
  const review = { summary: "S", findings: [{ severity: "P2", title: "b", file: "f.ts", line: 3, body: "x" }, { severity: "P0", title: "a", file: "g.ts", body: "y" }] }
  test("parse fenced and bare", () => {
    expect(parseReviewResult(JSON.stringify(review))?.summary).toBe("S")
    expect(parseReviewResult("```json\n" + JSON.stringify(review) + "\n```")?.summary).toBe("S")
    expect(parseReviewResult("prose")).toBeNull()
  })
  test("format sorts by severity and carries the marker", () => {
    const body = formatReviewComment(review, "", { model: "m", turns: 2, sha: "abcdef123" })
    expect(body.startsWith(MARKER)).toBe(true)
    expect(body.indexOf("P0")).toBeLessThan(body.indexOf("P2"))
    expect(body).toContain("`f.ts:3`")
    expect(body).toContain("at abcdef1")
    expect(formatReviewComment({ summary: "ok", findings: [] }, "")).toContain("No actionable findings")
    expect(formatReviewComment(null, "raw text")).toContain("raw text")
  })
})

function mockApi(initial: any[][]) {
  const calls: any[] = []
  return {
    calls,
    request: async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body })
      if (method === "GET") return initial[Number(new URL("http://x" + path).searchParams.get("page")) - 1] ?? []
      return { id: 99 }
    },
  }
}

describe("upsertComment", () => {
  const t = { owner: "o", repo: "r", number: 4, body: `${MARKER}\nnew` }
  test("creates when none exists", async () => {
    const api = mockApi([[{ id: 1, body: "other" }]])
    expect(await upsertComment(api, t)).toEqual({ action: "created", id: 99 })
    expect(api.calls.at(-1)).toMatchObject({ method: "POST", path: "/repos/o/r/issues/4/comments" })
  })
  test("updates the existing marked comment, even on page 2", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 10, body: "x" }))
    const api = mockApi([page1, [{ id: 7, body: `${MARKER} old` }]])
    expect(await upsertComment(api, t)).toEqual({ action: "updated", id: 7 })
    expect(api.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/repos/o/r/issues/comments/7" })
    expect(api.calls.filter((c) => c.method !== "GET").length).toBe(1)
  })
  test("makeApi sends the token and throws without echoing it", async () => {
    let seen: any
    const api = makeApi("tok-secret", (async (u: string, o: any) => { seen = o; return { ok: false, status: 403 } }) as any)
    await expect(api.request("GET", "/x")).rejects.toThrow("403")
    expect(seen.headers.authorization).toBe("Bearer tok-secret")
    const e = await api.request("GET", "/x").catch((e: Error) => e.message)
    expect(e).not.toContain("tok-secret")
  })
})

describe("branch safety, redaction, caps", () => {
  const ctx = { headRef: "feature/x", defaultBranch: "main" }
  test("assertSafeBranch", () => {
    expect(assertSafeBranch("ezkielyna/fix-ci-1", ctx)).toBe("ezkielyna/fix-ci-1")
    expect(() => assertSafeBranch("main", ctx)).toThrow()
    expect(() => assertSafeBranch("feature/x", ctx)).toThrow()
    expect(() => assertSafeBranch("ezkielyna/main", { headRef: "ezkielyna/main", defaultBranch: "main" })).toThrow("own branch")
    expect(() => assertSafeBranch("ezkielyna/a b", ctx)).toThrow()
  })
  test("fixBranchName is under ezkielyna/ and unique per run", () => {
    const a = fixBranchName("123", 1, new Date("2026-10-22T10:20:00Z"))
    expect(a).toBe("ezkielyna/fix-ci-123-1-202610221020")
    expect(fixBranchName("124", 1, new Date("2026-10-22T10:20:00Z"))).not.toBe(a)
    expect(fixBranchName("a/../b")).not.toContain("..")
  })
  test("redact", () => {
    expect(redact("key=abcd1234 and abcd1234", ["abcd1234", "", undefined])).toBe("key=*** and ***")
  })
  test("capDiff and tailLog", () => {
    const d = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const c = capDiff(d, 50)
    expect(c.truncated).toBe(true)
    expect(c.text.endsWith("[diff truncated]\n")).toBe(true)
    expect(capDiff("small").truncated).toBe(false)
    const t = tailLog(d, 40)
    expect(t.startsWith("[log start omitted]")).toBe(true)
    expect(t).toContain("line 99")
  })
})

describe("isProjectConfigPath", () => {
  test("matches bare symlink names and instruction dirs", () => {
    for (const f of [".ezkielyna", ".opencode", ".claude", ".agents", "a/.ezkielyna", ".claude/skills/x.md", ".agents/skills/s/SKILL.md", ".mcp.json", "pkg/ezkielyna.json"]) expect(isProjectConfigPath(f)).toBe(true)
    for (const f of ["src/a.ts", ".claudeX", "x.claude", ".github/workflows/ci.yml"]) expect(isProjectConfigPath(f)).toBe(false)
  })
})
