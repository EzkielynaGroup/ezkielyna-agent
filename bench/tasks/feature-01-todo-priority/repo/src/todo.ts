export type Todo = { id: number; title: string; done: boolean }

let nextId = 1

export function addTodo(list: Todo[], title: string): Todo[] {
  return [...list, { id: nextId++, title, done: false }]
}

export function complete(list: Todo[], id: number): Todo[] {
  return list.map((todo) => (todo.id === id ? { ...todo, done: true } : todo))
}
