import { expect, test } from "bun:test"
import { addTodo, complete } from "./todo"

test("add and complete", () => {
  const added = addTodo(addTodo([], "a"), "b")
  const list = complete(added, added[0]!.id)
  expect(list.map((todo) => [todo.title, todo.done])).toEqual([["a", true], ["b", false]])
})
