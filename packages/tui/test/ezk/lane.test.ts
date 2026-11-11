import { describe, expect, test } from "bun:test"
import { laneLang, laneT } from "../../src/ezk/lane-strings"
import { contextText, laneApi, taskLine, usageText } from "../../src/ezk/lane"

describe("exec lane TUI helpers", () => {
  test("language follows EZK_LANG, then LANG", () => {
    expect(laneLang({ LANG: "id_ID.UTF-8" })).toBe("id")
    expect(laneLang({ EZK_LANG: "en", LANG: "id_ID.UTF-8" })).toBe("en")
    expect(laneT("id")("tasks.title")).toBe("Tugas latar belakang")
  })
  test("task rows read plainly", () => {
    const base = { id: "bg_2", owner: "s", command: "bun run dev", cwd: "/", pid: 1, backend: "pty" as const, monitor: false, startedAt: 0, lastAttendedAt: 0, bytes: 0, preview: "" }
    expect(taskLine({ ...base, status: "exited", exitCode: 0, endedAt: 12_000 }, laneT("en"))).toBe("bg_2 · finished (0) · 12s · bun run dev")
    expect(taskLine({ ...base, status: "killed", exitCode: 143, endedAt: 3_000 }, laneT("id"))).toBe("bg_2 · dihentikan (143) · 3s · bun run dev")
  })
  test("api hits the exec routes", async () => {
    const urls: string[] = []
    const api = laneApi({ url: "http://h", fetch: (async (u: any) => (urls.push(String(u)), new Response(JSON.stringify({ enabled: false, tasks: [] })))) as unknown as typeof fetch })
    expect(await api.tasks("ses_1")).toEqual({ enabled: false, tasks: [] })
    await api.output("bg_1", "ses_1")
    expect(urls).toEqual(["http://h/ezk/exec?sessionID=ses_1", "http://h/ezk/exec/output?id=bg_1&sessionID=ses_1"])
  })
  test("/context and /usage text", () => {
    const text = contextText(
      {
        modelID: "flash",
        window: 128_000,
        used: 32_000,
        usedPct: 25,
        source: "measured",
        rows: [
          { part: "system", tokens: 2_000, pct: 1.6 },
          { part: "tools", tokens: 6_000, pct: 4.7 },
          { part: "instructions", tokens: 1_000, pct: 0.8 },
          { part: "memory", tokens: 500, pct: 0.4 },
          { part: "messages", tokens: 22_500, pct: 17.6 },
        ],
      },
      laneT("en"),
    )
    expect(text.split("\n")[0]).toBe("flash · 128k tokens")
    expect(text).toContain("Project instructions (AGENTS.md, CLAUDE.md)")
    expect(text).toContain("Used: 32k (25%) · counted by the model")
    const usage = usageText(
      { steps: 2, tokens: { input: 2_000, output: 300, cacheRead: 18_000, cacheWrite: 0 }, costUSD: 0.0042, cacheHitPct: 90, lastHitPct: 12, missCause: "model-switch", lastPromptTokens: 10_000 },
      laneT("id"),
      "id",
    )
    expect(usage).toContain("Perkiraan biaya: $0.0042")
    expect(usage).toContain("Cache: 90% (18k dari cache) · giliran terakhir 12%")
    expect(usage).toContain("Token: masuk 20k · keluar 300")
    expect(usage).toContain("Kenapa cache meleset: model berganti")
    expect(usageText({ steps: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUSD: 0, cacheHitPct: 0, lastHitPct: 0, lastPromptTokens: 0 }, laneT("en"))).toBe("Nothing used yet.")
  })
})
