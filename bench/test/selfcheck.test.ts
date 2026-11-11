import { expect, test } from "bun:test"
import { selfcheckProblems } from "../lib/selfcheck"

test("selfcheck accepts a fail-to-pass task", () => {
  expect(selfcheckProblems({ untouchedPass: false, solutionExit: 0, patchExit: 0, solvedPass: true })).toEqual([])
})

test("selfcheck rejects a task that passes untouched", () => {
  expect(selfcheckProblems({ untouchedPass: true, solutionExit: 0, patchExit: 0, solvedPass: true })).toContain(
    "untouched repo already passes",
  )
})

test("selfcheck reports a broken reference solution", () => {
  expect(selfcheckProblems({ untouchedPass: false, solutionExit: 1, patchExit: 1, solvedPass: false })).toEqual([
    "solution.sh exited 1",
    "solution.patch failed to apply (1)",
    "reference solution fails verification",
  ])
})
