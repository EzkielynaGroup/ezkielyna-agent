import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bugReportFilename } from "@opencode-ai/core/ezk/diag/report-file"
import { reportInstructions } from "../../src/ezk/bugreport-cli"
import { buildBugReport } from "../../src/ezk/bugreport"
import { saveBugReport } from "../../src/ezk/bugreport-file"
import { DEFAULT_FLAGS } from "@opencode-ai/core/ezk/flags"
import { DEFAULT_POLICY, mergePolicy } from "@opencode-ai/core/ezk/model-policy"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("lapor CLI output", () => {
  test("writes a named report in the current directory", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-lapor-cli-"))
    dirs.push(cwd)
    const now = new Date(2026, 9, 22, 9, 7)
    const file = await saveBugReport({ report: "safe report", cwd, now })
    expect(path.basename(file)).toBe(bugReportFilename(now))
    expect(await fs.readFile(file, "utf8")).toBe("safe report")
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  test("honors --out as a file path and prints localized safety instructions", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-lapor-out-"))
    dirs.push(cwd)
    const out = path.join("nested", "custom.txt")
    const file = await saveBugReport({ report: "safe report", cwd, out })
    expect(await fs.readFile(file, "utf8")).toBe("safe report")
    expect(reportInstructions("id")).toContain("Jangan kirim API key.")
    expect(reportInstructions("en")).toContain("Do not send your API key.")
  })

  test("assembles diagnostics from injected local data without a live request", async () => {
    let modelChecks = 0
    const report = await buildBugReport({
      doctor: {
        version: "1.2.0",
        key: () => ({ present: true, source: "saved" }),
        models: async () => {
          modelChecks++
          return { ok: true, status: 200, ms: 8, ids: ["auto", "model-x"] }
        },
        configSources: () => [{ path: "/Users/tester/.config/ezkielyna/ezkielyna.json", exists: true }],
        trust: () => ({ dir: "/Users/tester/project", trusted: true }),
        diskFreeBytes: () => 4 * 1024 ** 3,
        dataDir: "/Users/tester/.local/share/ezkielyna",
        updateURL: "",
        features: "+diagnostics",
      },
      flags: DEFAULT_FLAGS,
      language: "en",
      version: "1.2.0",
      channel: "beta",
      os: "Darwin 25.0",
      arch: "arm64",
      locale: "en-US",
      homeDir: "/Users/tester",
      freeRamBytes: 5 * 1024 ** 3,
      model: "ezkielyna/auto",
      readLogs: () => ["level=Error message=failed request status=503 token=secret-token"],
      policy: async () => mergePolicy(DEFAULT_POLICY, { models: { "model-x": { groups: ["member"] } } }),
      now: () => new Date("2026-10-22T00:00:00.000Z"),
    })

    expect(modelChecks).toBe(1)
    expect(report).toContain("Current model: ezkielyna/auto")
    expect(report).toContain("Key group (estimated): standard")
    expect(report).toContain("API key: present")
    expect(report).not.toContain("secret-token")
    expect(report).toContain("~/project")
  })
})
