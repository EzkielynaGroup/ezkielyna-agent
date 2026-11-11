import { expect, test } from "bun:test"
import { createUser } from "./user"
import { invite } from "./invite"
import { subscribe } from "./newsletter"

test("valid users and invites", () => {
  expect(createUser("Ani", "Ani@Example.com").email).toBe("ani@example.com")
  expect(invite("a@x.io", "b@y.io").subject).toBe("a@x.io invited you")
  expect(subscribe("c@z.id")).toBe(1)
})

test("rejects bad emails with the same message", () => {
  expect(() => createUser("Ani", "nope")).toThrow("invalid email: nope")
  expect(() => invite("a@x.io", "b@")).toThrow("invalid email: b@")
  expect(() => subscribe("x y@z.id")).toThrow("invalid email: x y@z.id")
})
