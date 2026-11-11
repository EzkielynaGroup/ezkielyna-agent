// Task loading, workspace preparation and verification shared by bench/run.ts and bench/check-tasks.ts.
//
// Task layout (bench/tasks/<id>/):
//   task.json     metadata, prompt and how to grade (see TaskSpec)
//   repo/         the starting workspace the agent sees (copied to a fresh temp dir and committed to git)
//   hidden/       hidden files copied over the workspace after the agent finishes, before verify runs
//                 (the agent cannot weaken them; SWE-bench FAIL_TO_PASS / Terminal-Bench tests/ style)
//   solution.sh   reference solution, run from the workspace root; never shown to the agent in real runs
//   solution.md   reference answer for keyword-graded Q&A tasks
import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { safeEnvironment } from "./environment"

export const TASKS_DIR = path.join(import.meta.dir, "..", "tasks")
export const CATEGORIES = ["bugfix", "refactor", "feature", "qa", "data", "awam"] as const

export type TaskSpec = {
  id: string
  category: (typeof CATEGORIES)[number]
  /** Prompt language: id (Indonesian), en, or mix. */
  lang: "id" | "en" | "mix"
  title: string
  prompt: string
  /** Shell command run with bash in the workspace after the hidden tests are copied in; exit 0 = pass. */
  verify?: string
  /** Q&A grading: every group must match the agent's final answer (case-insensitive); a group lists alternatives. */
  keywords?: string[][]
  /** Agent time limit in seconds (default 600). */
  timeout_sec?: number
}

export type Task = TaskSpec & { dir: string }

export async function loadTasks(filter?: string) {
  const ids = (await readdir(TASKS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const tasks = await Promise.all(ids.map((id) => loadTask(id)))
  return tasks.filter((task) => matches(task, filter))
}

async function loadTask(id: string): Promise<Task> {
  const dir = path.join(TASKS_DIR, id)
  const spec = (await Bun.file(path.join(dir, "task.json")).json()) as TaskSpec
  if (spec.id !== id) throw new Error(`${id}/task.json has id ${spec.id}`)
  if (!CATEGORIES.includes(spec.category)) throw new Error(`${id}: unknown category ${spec.category}`)
  if (!spec.verify && !spec.keywords?.length) throw new Error(`${id}: needs verify or keywords`)
  return { ...spec, dir }
}

// --tasks accepts comma-separated ids, id prefixes ("bugfix-0") or categories ("category:data").
function matches(task: Task, filter?: string) {
  if (!filter) return true
  return filter
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .some((item) => {
      if (item.startsWith("category:")) return task.category === item.slice(9)
      return task.id === item || task.id.startsWith(item)
    })
}

/** Copies repo/ into a fresh temp dir and commits it, so the agent (and a reviewer) can `git diff` its work. */
export async function prepareWorkspace(task: Task) {
  const ws = await mkdtemp(path.join(tmpdir(), `bench-${task.id}-`))
  if (await exists(path.join(task.dir, "repo"))) await cp(path.join(task.dir, "repo"), ws, { recursive: true })
  // the VPS image makes bench/tasks read-only; cp keeps those modes, so give the workspace copy back its write bits
  await sh("chmod -R u+w .", ws)
  await sh(
    "git init -q && git add -A && git -c user.email=bench@ezkielyna.invalid -c user.name=bench commit -q --allow-empty -m 'task start'",
    ws,
  )
  return ws
}

export async function copyHiddenTests(task: Task, ws: string) {
  if (await exists(path.join(task.dir, "hidden")))
    await cp(path.join(task.dir, "hidden"), ws, { recursive: true, force: true })
}

export async function runSolution(task: Task, ws: string) {
  const script = path.join(task.dir, "solution.sh")
  if (!(await exists(script))) return { code: 0, output: "" }
  return sh(`bash ${JSON.stringify(script)}`, ws, 300_000)
}

export async function referenceAnswer(task: Task) {
  const file = Bun.file(path.join(task.dir, "solution.md"))
  return (await file.exists()) ? file.text() : ""
}

/** Grades a workspace (hidden tests must already be copied in) and, for Q&A tasks, the final answer text. */
export async function verify(task: Task, ws: string, answer: string) {
  const command = task.verify ? await sh(task.verify, ws, 300_000) : undefined
  const missing = (task.keywords ?? []).filter(
    (group) => !group.some((word) => answer.toLowerCase().includes(word.toLowerCase())),
  )
  return {
    pass: (command ? command.code === 0 : true) && missing.length === 0,
    verify_exit: command?.code,
    verify_output: command?.output.slice(-4000),
    missing_keywords: missing.map((group) => group.join(" | ")),
  }
}

export async function removeWorkspace(ws: string) {
  await rm(ws, { recursive: true, force: true }).catch(() => {})
}

export async function sh(command: string, cwd: string, timeout = 60_000) {
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    env: {
      ...safeEnvironment(),
      PWD: cwd,
      NO_COLOR: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const timer = setTimeout(() => proc.kill(), timeout)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, output: stdout + stderr }
}

function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}
