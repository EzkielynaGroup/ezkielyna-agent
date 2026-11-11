import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { CATEGORIES, loadTasks, TASKS_DIR } from "../lib/tasks"

const EXPECTED = { bugfix: 8, refactor: 6, feature: 6, qa: 4, data: 3, awam: 3 }

test("30 tasks in the agreed mix", async () => {
  const tasks = await loadTasks()
  expect(tasks.length).toBe(30)
  const counts = Object.fromEntries(
    CATEGORIES.map((category) => [category, tasks.filter((task) => task.category === category).length]),
  )
  expect(counts).toEqual(EXPECTED)
})

test("every task is gradable, small and has a prompt", async () => {
  for (const task of await loadTasks()) {
    expect(task.prompt.length).toBeGreaterThan(40)
    expect(Boolean(task.verify) || Boolean(task.keywords?.length)).toBe(true)
    const files = await readdir(path.join(TASKS_DIR, task.id), { recursive: true })
    expect(files.length).toBeLessThanOrEqual(50)
    if (task.category === "qa") expect(task.keywords?.length).toBeGreaterThan(0)
  }
})

test("languages: TS/JS, Python and Go, prompts in Indonesian, English and mixed", async () => {
  const tasks = await loadTasks()
  const verify = tasks.map((task) => task.verify ?? "").join("\n")
  expect(verify).toContain("bun test")
  expect(verify).toContain("python3")
  expect(verify).toContain("go test")
  expect(new Set(tasks.map((task) => task.lang))).toEqual(new Set(["id", "en", "mix"]))
  expect(tasks.filter((task) => task.category === "awam").every((task) => task.lang === "id")).toBe(true)
})

test("--tasks filter: ids, prefixes and categories", async () => {
  expect((await loadTasks("bugfix-01-date-range")).map((task) => task.id)).toEqual(["bugfix-01-date-range"])
  expect((await loadTasks("bugfix-0")).length).toBe(8)
  expect((await loadTasks("category:data,qa-01")).map((task) => task.id)).toEqual([
    "data-01-ringkasan-penjualan",
    "data-02-excel-stok",
    "data-03-bersihkan-pelanggan",
    "qa-01-explain-shortener",
  ])
})
