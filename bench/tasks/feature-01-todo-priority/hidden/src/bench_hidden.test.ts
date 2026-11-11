import { expect, test } from "bun:test"
import { addTodo, complete, sortByPriority } from "./todo"

test("priority defaults to normal", () => {
  expect(addTodo([], "x")[0]).toMatchObject({ title: "x", priority: "normal", done: false })
})

test("sortByPriority", () => {
  let list = addTodo([], "n1")
  list = addTodo(list, "l1", "low")
  list = addTodo(list, "h1", "high")
  list = addTodo(list, "n2", "normal")
  list = addTodo(list, "h2", "high")
  list = complete(list, list[4]!.id)
  const before = list.map((todo) => todo.title)
  expect(sortByPriority(list).map((todo) => todo.title)).toEqual(["h1", "n1", "n2", "l1", "h2"])
  expect(list.map((todo) => todo.title)).toEqual(before)
})
