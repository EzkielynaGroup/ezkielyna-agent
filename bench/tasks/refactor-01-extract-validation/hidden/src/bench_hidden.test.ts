import { expect, test } from "bun:test"
import { isValidEmail } from "./validation"

test("isValidEmail", () => {
  expect(isValidEmail("a@b.co")).toBe(true)
  expect(isValidEmail("a@b")).toBe(false)
  expect(isValidEmail("a b@c.de")).toBe(false)
})
