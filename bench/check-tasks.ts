#!/usr/bin/env bun
// Validates the task set without any agent or model:
//   - the untouched repo must FAIL verification (otherwise the task measures nothing), and
//   - the reference solution (solution.sh / solution.md) must PASS it.
//
//   bun bench/check-tasks.ts [--tasks <filter>] [--keep]
import { parseArgs } from "node:util"
import {
  copyHiddenTests,
  loadTasks,
  prepareWorkspace,
  referenceAnswer,
  removeWorkspace,
  runSolution,
  verify,
} from "./lib/tasks"

const args = parseArgs({
  options: { tasks: { type: "string" }, keep: { type: "boolean", default: false } },
}).values

const tasks = await loadTasks(args.tasks)
if (tasks.length === 0) {
  console.error(`no tasks match ${args.tasks}`)
  process.exit(2)
}

const counts = Object.groupBy(tasks, (task) => task.category)
console.log(
  `${tasks.length} task(s): ${Object.entries(counts)
    .map(([category, items]) => `${category} ${items?.length}`)
    .join(", ")}\n`,
)

const problems: string[] = []
for (const task of tasks) {
  const started = performance.now()
  const before = await prepareWorkspace(task)
  await copyHiddenTests(task, before)
  const untouched = await verify(task, before, "")

  const after = await prepareWorkspace(task)
  const solution = await runSolution(task, after)
  await copyHiddenTests(task, after)
  const solved = await verify(task, after, await referenceAnswer(task))

  const issues = [
    untouched.pass ? "untouched repo already passes" : undefined,
    solution.code !== 0 ? `solution.sh exited ${solution.code}` : undefined,
    solved.pass ? undefined : "reference solution fails verification",
  ].filter((issue): issue is string => Boolean(issue))
  const ms = Math.round(performance.now() - started)
  console.log(
    `${issues.length ? "FAIL" : "ok  "} ${task.id} (${ms} ms)${issues.length ? `: ${issues.join("; ")}` : ""}`,
  )
  if (issues.length) {
    if (!solved.pass)
      console.log(
        indent(`${solution.output}\n${solved.verify_output ?? ""}\nmissing: ${solved.missing_keywords.join(", ")}`),
      )
    problems.push(task.id)
  }
  if (!args.keep) await Promise.all([removeWorkspace(before), removeWorkspace(after)])
  if (args.keep) console.log(`     workspaces: ${before} ${after}`)
}

if (problems.length) {
  console.error(`\n${problems.length} task(s) invalid: ${problems.join(", ")}`)
  process.exit(1)
}
console.log(`\nall ${tasks.length} task(s) valid`)

function indent(text: string) {
  return text
    .trim()
    .split("\n")
    .slice(-30)
    .map((line) => `     | ${line}`)
    .join("\n")
}
