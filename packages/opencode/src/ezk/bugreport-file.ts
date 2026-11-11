import fs from "node:fs/promises"
import path from "node:path"
import { bugReportFilename } from "@opencode-ai/core/ezk/diag/report-file"

export async function saveBugReport(input: {
  report: string
  cwd: string
  out?: string
  now?: Date
  writeFile?: (file: string, content: string, encoding: "utf8") => Promise<unknown>
}) {
  const target = path.resolve(input.cwd, input.out || bugReportFilename(input.now ?? new Date()))
  await fs.mkdir(path.dirname(target), { recursive: true })
  if (input.writeFile) await input.writeFile(target, input.report, "utf8")
  else await fs.writeFile(target, input.report, { encoding: "utf8", mode: 0o600 })
  return target
}
