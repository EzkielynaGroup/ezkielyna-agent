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

const files = sources("src")
const withRegex = files.filter((file) => read(file).includes("[^\\s@]+@"))
if (withRegex.length !== 1 || !withRegex[0]!.endsWith("validation.ts"))
  fail(`the email regex should live only in src/validation.ts, found in: ${withRegex.join(", ") || "nowhere"}`)
for (const name of ["user.ts", "newsletter.ts", "invite.ts"])
  if (!/from ["']\.\/validation["']/.test(read(path.join("src", name)))) fail(`src/${name} does not import ./validation`)

if (problems.length) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"))
  process.exit(1)
}
console.log("structure ok")
