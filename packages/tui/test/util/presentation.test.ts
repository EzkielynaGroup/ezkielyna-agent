import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("ezkielyna -s ses_123")
})

// P2: the exit banner printed the upstream product's block logo.
test("the exit banner draws the Ezkielyna wordmark, not the upstream one", () => {
  const plain = sessionEpilogue({ title: "A session", sessionID: "ses_123" }).replace(/\x1b\[[0-9;]*m/g, "")
  expect(plain).toContain("█▀▀█ ▀▀▀█ █ ▄▀ ▄ █▀▀█") // "ezkie"
  expect(plain).toContain("█ █  █ █▀▀▄ ▄▀▀█") // "lyna"
  expect(plain).not.toContain("█▀▀█ █▀▀█ █▀▀█ █▀▀▄") // "open"
  expect(plain).not.toContain("█▀▀▀ █▀▀█ █▀▀█ █▀▀█") // "code"
})
