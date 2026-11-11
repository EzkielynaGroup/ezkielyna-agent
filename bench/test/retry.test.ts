import { expect, test } from "bun:test"
import { retryableInfrastructureFailure } from "../lib/retry"

test("retryable infrastructure failures include 429, 5xx, network and timeout errors", () => {
  for (const stderr of ["HTTP 429 too many requests", "HTTP 503 upstream error", "ECONNRESET", "request timed out"]) {
    expect(retryableInfrastructureFailure({ exitCode: 1, timedOut: false, stdout: "", stderr })).toBe(true)
  }
  expect(retryableInfrastructureFailure({ exitCode: null, timedOut: true, stdout: "", stderr: "" })).toBe(true)
})

test("never retry quota, balance, context or model failures", () => {
  for (const stderr of ["HTTP 429 quota exceeded", "insufficient balance", "context overflow", "invalid API key", "model not found"]) {
    expect(retryableInfrastructureFailure({ exitCode: 1, timedOut: false, stdout: "", stderr })).toBe(false)
  }
})

test("ordinary model and task failures are not retried", () => {
  expect(retryableInfrastructureFailure({ exitCode: 1, timedOut: false, stdout: "", stderr: "model refused the request" })).toBe(false)
  expect(retryableInfrastructureFailure({ exitCode: 0, timedOut: false, stdout: "answer: 503", stderr: "" })).toBe(false)
})
