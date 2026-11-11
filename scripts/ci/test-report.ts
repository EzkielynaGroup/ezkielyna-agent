#!/usr/bin/env bun
// Turns the logs written by .github/workflows/test.yml into a failure report.
//
//   UNIT_OUTCOME=failure GENERATED_OUTCOME=success HTTPAPI_OUTCOME=success bun scripts/ci/test-report.ts test-output
//
// Reads <dir>/unit.log (`bun turbo test --log-prefix=task`), <dir>/generated.log and <dir>/httpapi.log, and writes
//   <dir>/report.md     summary + every failing test, grouped by package and file (also printed to stdout)
//   <dir>/failures.tsv  one row per failing test: package, file, test name
import path from "node:path"

const dir = process.argv[2]
if (!dir) {
  console.error("usage: bun scripts/ci/test-report.ts <dir with unit.log, generated.log, httpapi.log>")
  process.exit(2)
}

const read = (name: string) =>
  Bun.file(path.join(dir, name))
    .text()
    .then((text) => text.replace(/\x1b\[[0-9;]*m/g, ""))
    .catch(() => "")

const unit = parseUnit(await read("unit.log"))
const generated = await read("generated.log")
const httpapi = await read("httpapi.log")
const outcome = {
  unit: process.env.UNIT_OUTCOME ?? "unknown",
  generated: process.env.GENERATED_OUTCOME ?? "unknown",
  httpapi: process.env.HTTPAPI_OUTCOME ?? "unknown",
}

const report = [
  "## Test report",
  "",
  "| Step | Result |",
  "|---|---|",
  `| \`bun turbo test\` | ${icon(outcome.unit)} ${outcome.unit}: ${unit.failures.length} failing test(s)${unit.failedTasks.length ? ` in ${unit.failedTasks.join(", ")}` : ""} |`,
  `| \`packages/client\` \`check:generated\` | ${icon(outcome.generated)} ${outcome.generated} |`,
  `| \`packages/opencode\` \`test:httpapi\` | ${icon(outcome.httpapi)} ${outcome.httpapi} |`,
  "",
  "### Per package",
  "",
  "| Package | Pass | Fail | Failing tests listed below |",
  "|---|---|---|---|",
  ...[...unit.counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([pkg, count]) =>
        `| ${pkg} | ${count.pass} | ${count.fail} | ${unit.failures.filter((item) => item.pkg === pkg).length} |`,
    ),
  "",
  ...failureSection(unit.failures),
  ...(outcome.generated === "failure" ? generatedSection(generated) : []),
  ...(outcome.httpapi === "failure" ? httpapiSection(httpapi) : []),
].join("\n")

await Bun.write(path.join(dir, "report.md"), report + "\n")
await Bun.write(
  path.join(dir, "failures.tsv"),
  ["package\tfile\ttest", ...unit.failures.map((item) => `${item.pkg}\t${item.file}\t${item.name}`)].join("\n") + "\n",
)
console.log(report)

// `bun turbo test --log-prefix=task` prefixes every line with "<package>:test: ". Bun prints "<file>:" before the
// results of each test file, "(fail) <name> [<ms>]" per failing test and " <n> pass" / " <n> fail" totals.
function parseUnit(log: string) {
  const files = new Map<string, string>()
  const counts = new Map<string, { pass: number; fail: number }>()
  const failures: { pkg: string; file: string; name: string }[] = []
  const failedTasks = (log.match(/^\s*Failed:\s+(.+)$/m)?.[1] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  log.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^(\S+?):test: ?(.*)$/)
    if (!match) return
    const pkg = match[1]!
    const rest = match[2]!
    const header = rest.match(/^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/)
    if (header) return files.set(pkg, header[1]!)
    if (rest.startsWith("(fail) "))
      return failures.push({ pkg, file: files.get(pkg) ?? "?", name: rest.slice(7).replace(/\s*\[[\d.]+m?s\]$/, "") })
    if (rest.startsWith("# Unhandled error"))
      return failures.push({ pkg, file: files.get(pkg) ?? "?", name: "(unhandled error between tests)" })
    const total = rest.match(/^\s*(\d+) (pass|fail)$/)
    if (!total) return
    const count = counts.get(pkg) ?? { pass: 0, fail: 0 }
    count[total[2] as "pass" | "fail"] += Number(total[1])
    counts.set(pkg, count)
  })
  return { failures, counts, failedTasks }
}

function failureSection(failures: { pkg: string; file: string; name: string }[]) {
  if (failures.length === 0) return ["No failing tests.", ""]
  const byPkg = Map.groupBy(failures, (item) => item.pkg)
  return [
    `### Failing tests (${failures.length})`,
    "",
    ...[...byPkg.entries()].flatMap(([pkg, items]) => [
      `<details><summary><b>${pkg}</b>: ${items.length}</summary>`,
      "",
      ...[...Map.groupBy(items, (item) => item.file).entries()].flatMap(([file, tests]) => [
        `- \`${file}\``,
        ...tests.map((test) => `  - ${test.name.replaceAll("|", "\\|")}`),
      ]),
      "",
      "</details>",
      "",
    ]),
  ]
}

function generatedSection(log: string) {
  // check:generated ends with `git diff --exit-code`, so the changed files appear as "diff --git a/<file> b/<file>".
  const changed = log
    .split(/\r?\n/)
    .map((line) => line.match(/^diff --git a\/(\S+) b\//)?.[1])
    .filter((file): file is string => Boolean(file))
  if (changed.length === 0) return tailSection("`check:generated` output (tail)", log)
  return [
    "### `check:generated`: regenerated client differs from the committed one",
    "",
    "Fix by running `bun run generate` in `packages/client` on the application branch and committing the result.",
    "",
    ...changed.map((file) => `- \`${file}\``),
    "",
  ]
}

// The exerciser prints "FAIL <METHOD> <path> <scenario>" followed by "  Error: <message>", then "summary pass=… fail=…".
function httpapiSection(log: string) {
  const lines = log.split(/\r?\n/)
  const summary = lines.findLast((line) => line.includes("summary pass="))?.trim()
  const errors = lines
    .map((line) => line.match(/^\s+Error: (.+)$/)?.[1]?.trim())
    .filter((message): message is string => Boolean(message))
  if (!summary && errors.length === 0) return tailSection("`test:httpapi` output (tail)", log)
  const counts = [...Map.groupBy(errors, (message) => message).entries()].sort((a, b) => b[1].length - a[1].length)
  return [
    "### `test:httpapi` (HttpApi exerciser)",
    "",
    ...(summary ? [`\`${summary}\``, ""] : []),
    "| Count | Error |",
    "|---|---|",
    ...counts.slice(0, 20).map(([message, items]) => `| ${items.length} | ${message.replaceAll("|", "\\|")} |`),
    "",
    ...tailSection("`test:httpapi` output (tail)", log).slice(1),
  ]
}

function tailSection(title: string, log: string) {
  return [`### ${title}`, "", "```", ...log.trimEnd().split(/\r?\n/).slice(-40), "```", ""]
}

function icon(result: string) {
  if (result === "success") return "✅"
  if (result === "failure") return "❌"
  return "⚪"
}
