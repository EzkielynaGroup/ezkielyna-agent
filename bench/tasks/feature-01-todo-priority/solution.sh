cat > src/todo.ts <<'EOF'
export type Priority = "low" | "normal" | "high"
export type Todo = { id: number; title: string; done: boolean; priority: Priority }

let nextId = 1
const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 }

export function addTodo(list: Todo[], title: string, priority: Priority = "normal"): Todo[] {
  return [...list, { id: nextId++, title, done: false, priority }]
}

export function complete(list: Todo[], id: number): Todo[] {
  return list.map((todo) => (todo.id === id ? { ...todo, done: true } : todo))
}

export function sortByPriority(list: Todo[]): Todo[] {
  return [...list].sort((a, b) => Number(a.done) - Number(b.done) || RANK[a.priority] - RANK[b.priority])
}
EOF
cat > src/priority.test.ts <<'EOF'
import { expect, test } from "bun:test"
import { addTodo, sortByPriority } from "./todo"

test("sortByPriority puts high first", () => {
  const list = addTodo(addTodo([], "a", "low"), "b", "high")
  expect(sortByPriority(list).map((todo) => todo.title)).toEqual(["b", "a"])
})
EOF
