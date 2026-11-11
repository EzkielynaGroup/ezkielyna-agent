import { describe, expect, test } from "bun:test"
import { redactBugReport, renderBugReport } from "../../../src/ezk/diag/report"

describe("bug report redaction", () => {
  test("redacts secrets across every final report field", () => {
    const secret = "sk-" + "test_1234567890abcdef"
    const ezkSecret = "ezk-test_1234567890abcdef"
    const report = renderBugReport({
      language: "id",
      generatedAt: `2026-10-22 ${secret}`,
      version: `1.0 ${ezkSecret}`,
      channel: `beta ${secret}`,
      os: `Mac ${secret}`,
      arch: `arm64 ${ezkSecret}`,
      locale: "tester@example.invalid",
      checks: [{ id: "gateway", status: "fail", label: `Gateway ${ezkSecret}`, detail: `Authorization: Bearer ${secret}` }],
      features: `+router ?token=${secret}`,
      enabledFlags: [`x-api-key=${secret}`],
      model: `model-${secret}`,
      models: [{ id: "auto", groups: ["member"] }],
      keyPresent: true,
      logLines: [
        `ERROR body=${secret}`,
        `WARN https://example.invalid/path?key=${ezkSecret}`,
        "WARN tester@example.invalid failed",
        "ERROR /Users/tester/private/file.ts",
      ],
      lastFailedRequest: { status: 503, error: `request failed x-api-key: ${secret}; password=secretpass` },
      freeDiskBytes: 1024 ** 3,
      freeRamBytes: 2 * 1024 ** 3,
      homeDir: "/Users/tester",
    })

    expect(report).not.toContain(secret)
    expect(report).not.toContain(ezkSecret)
    expect(report).not.toContain("tester@example.invalid")
    expect(report).not.toContain("/Users/tester")
    expect(report).not.toContain("secretpass")
    expect(report).toContain("Kunci API: ada")
    expect(report).toContain("~/private/file.ts")
  })

  test("redacts credentials in headers, URLs, email, and home paths in arbitrary final text", () => {
    const result = redactBugReport(
      "Authorization: Bearer abcdefghijkl x-api-key: value123456789 https://x.invalid/?password=p4ssword a@b.example /Users/me/a",
      "/Users/me",
    )
    expect(result).not.toContain("abcdefghijkl")
    expect(result).not.toContain("value123456789")
    expect(result).not.toContain("p4ssword")
    expect(result).not.toContain("a@b.example")
    expect(result).toContain("~/a")
  })

  test("keeps only key presence and caps logs to the last 50 lines", () => {
    const report = renderBugReport({
      language: "en",
      generatedAt: "now",
      version: "1.0",
      channel: "beta",
      os: "Linux",
      arch: "x64",
      locale: "en-US",
      checks: [],
      enabledFlags: [],
      models: [],
      keyPresent: false,
      logLines: Array.from({ length: 55 }, (_, i) => `WARN line-${i}`),
    })
    expect(report).toContain("API key: missing")
    expect(report).not.toContain("line-4\n")
    expect(report).toContain("line-5")
    expect(report).toContain("line-54")
  })
})
