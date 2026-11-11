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

if (existsSync("src/utils.ts")) fail("src/utils.ts should be deleted")
for (const file of sources("src")) if (/from ["']\.\/utils["']/.test(read(file))) fail(`${file} still imports ./utils`)

if (problems.length) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"))
  process.exit(1)
}
console.log("structure ok")
