#!/usr/bin/env bun
// Model-free task selfcheck. Each task must fail untouched and pass after its reference solution.
// The reference diff is saved as solution.patch before hidden tests are copied into the workspace.
import { appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { loadTasks, prepareWorkspace, copyHiddenTests, referenceAnswer, removeWorkspace, runSolution, sh, verify } from "./lib/tasks"
import { selfcheckProblems } from "./lib/selfcheck"

const args = parseArgs({ options: { tasks: { type: "string" }, keep: { type: "boolean", default: false } } }).values
const tasks = await loadTasks(args.tasks)
if (tasks.length === 0) {
  console.error(`no tasks match ${args.tasks}`)
  process.exit(2)
}

const resultsFile = path.join(tmpdir(), `bench-selfcheck-${Date.now()}.jsonl`)
await Bun.write(resultsFile, "")
const problems: string[] = []
for (const task of tasks) {
  const started = performance.now()
  const before = await prepareWorkspace(task)
  await copyHiddenTests(task, before)
  const untouched = await verify(task, before, "")

  const solutionWorkspace = await prepareWorkspace(task)
  const solution = await runSolution(task, solutionWorkspace)
  const patch = await sh("git add -A && git diff --cached --binary HEAD", solutionWorkspace)
  if (patch.code === 0) await Bun.write(path.join(task.dir, "solution.patch"), patch.output)

  const patched = await prepareWorkspace(task)
  const patchFile = path.join(task.dir, "solution.patch")
  const patchExit = patch.code !== 0
    ? patch.code
    : patch.output.length === 0
      ? 0
      : (await sh(`git apply --binary ${JSON.stringify(patchFile)}`, patched)).code
  await copyHiddenTests(task, patched)
  const solved = await verify(task, patched, await referenceAnswer(task))
  const issues = selfcheckProblems({
    untouchedPass: untouched.pass,
    solutionExit: solution.code,
    patchExit,
    solvedPass: solved.pass,
  })
  const ms = Math.round(performance.now() - started)
  const result = {
    id: task.id,
    category: task.category,
    untouched_pass: untouched.pass,
    solution_exit: solution.code,
    patch_exit: patchExit,
    solved_pass: solved.pass,
    patch_bytes: patch.output.length,
    elapsed_ms: ms,
    problems: issues,
  }
  await appendFile(resultsFile, JSON.stringify(result) + "\n")
  console.log(`${issues.length ? "FAIL" : "PASS fail→pass"} ${task.id} (${ms} ms)${issues.length ? `: ${issues.join("; ")}` : ""}`)
  if (issues.length) {
    const detail = [solution.output, solved.verify_output ?? "", `missing: ${solved.missing_keywords.join(", ")}`]
      .filter(Boolean)
      .join("\n")
    problems.push(task.id)
    console.log(detail.trim().split("\n").slice(-24).map((line) => `  ${line}`).join("\n"))
  }
  if (!args.keep) await Promise.all([removeWorkspace(before), removeWorkspace(solutionWorkspace), removeWorkspace(patched)])
  if (args.keep) console.log(`  workspaces: ${before} ${solutionWorkspace} ${patched}`)
}

if (!args.tasks) {
  const counts = Object.groupBy(tasks, (task) => task.category)
  const expected = { bugfix: 8, refactor: 6, feature: 6, qa: 4, data: 3, awam: 3 }
  for (const [category, expectedCount] of Object.entries(expected)) {
    const actual = counts[category as keyof typeof counts]?.length ?? 0
    if (actual !== expectedCount) problems.push(`mix:${category}`)
  }
}

console.log(`details: ${resultsFile}`)
if (problems.length) {
  console.error(`\n${problems.length} invalid task(s): ${problems.join(", ")}`)
  process.exit(1)
}
console.log(`\nall ${tasks.length} task(s) fail untouched and pass with solution.patch`)
