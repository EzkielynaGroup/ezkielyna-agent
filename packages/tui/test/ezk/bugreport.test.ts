import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createBugReportCommand, fetchBugReport, saveTuiBugReport } from "../../src/ezk/bugreport"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("TUI /lapor", () => {
  test("fetches a report, saves it in the working directory and shows the path", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-lapor-tui-"))
    dirs.push(directory)
    const messages: { title?: string; message: string; variant: string }[] = []
    const requests: { url: string; method?: string; body?: BodyInit | null }[] = []
    const command = createBugReportCommand({
      language: "id",
      request: () => fetchBugReport({
        url: "http://127.0.0.1:4096",
        directory,
        headers: {},
        fetch: (async (url, options) => {
          requests.push({ url: String(url), method: options?.method, body: options?.body })
          return new Response(JSON.stringify({ enabled: true, report: "redacted report" }))
        }) as typeof fetch,
      }),
      save: (report) => saveTuiBugReport(report, directory, new Date(2026, 9, 22, 9, 7)),
      toast: { show: (value) => void messages.push(value) },
    })
    await command.run()
    expect(command.slash.name).toBe("lapor")
    expect(requests).toEqual([{ url: "http://127.0.0.1:4096/ezk/bugreport", method: "GET", body: undefined }])
    expect(messages[0]?.title).toContain("ezkielyna-laporan-20261022-0907.txt")
    expect(messages[0]?.message).toContain("Jangan kirim API key.")
    expect(await fs.readFile(path.join(directory, "ezkielyna-laporan-20261022-0907.txt"), "utf8")).toBe("redacted report")
  })
})
