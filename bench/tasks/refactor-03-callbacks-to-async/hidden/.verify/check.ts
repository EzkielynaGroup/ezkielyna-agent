// Hidden structural checks for this refactor task (run by verify after the agent finishes).
import { readdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"

const problems: string[] = []
const fail = (message: string) => problems.push(message)
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")
const sources = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file))
    .map((file) => path.join(dir, file))

for (const file of sources("src")) {
  const text = read(file)
  if (/\bcb\b|Callback|callback/.test(text)) fail(`${file} still has a callback parameter`)
}

if (problems.length) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"))
  process.exit(1)
}
console.log("structure ok")
