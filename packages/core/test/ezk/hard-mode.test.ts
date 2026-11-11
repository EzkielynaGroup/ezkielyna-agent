import { describe, expect, test } from "bun:test"
import { hardAttemptBudget, hardAttemptConcurrency, hardModeFinalists, normalizeHardDiff } from "../../src/ezk/loop/hard"

const GIB = 1024 ** 3

describe("hard mode policy", () => {
  test("keeps three attempts sequential on 8 GB machines and only opens parallelism above 16 GB", () => {
    expect(hardAttemptConcurrency(8 * GIB)).toBe(1)
    expect(hardAttemptConcurrency(16 * GIB)).toBe(1)
    expect(hardAttemptConcurrency(32 * GIB)).toBe(3)
    expect(hardAttemptConcurrency(Number.NaN)).toBe(1)
  })

  test("slices only the unspent budget over the remaining attempts", () => {
    expect(hardAttemptBudget(0.9, 0, 3)).toBeCloseTo(0.3)
    expect(hardAttemptBudget(0.9, 0.3, 2)).toBeCloseTo(0.3)
    expect(hardAttemptBudget(0.9, 0.9, 1)).toBe(0)
    expect(hardAttemptBudget(0.9, 0, 0)).toBe(0)
  })

  test("normalizes whitespace and comments but preserves file paths, string content, and change direction", () => {
    const left = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", '-const text = "a b"; // first', "+const value = 1;"].join("\n")
    const right = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", '- const text = "a b"; // another', "+ const value=1; /* note */"].join("\n")
    expect(normalizeHardDiff(left)).toBe(normalizeHardDiff(right))
    expect(normalizeHardDiff(left)).not.toBe(normalizeHardDiff(right.replace('"a b"', '"ab"')))
    expect(normalizeHardDiff(left)).not.toBe(normalizeHardDiff(right.replace("a/src/a.ts", "a/src/b.ts").replace("b/src/a.ts", "b/src/b.ts")))
  })

  test("keeps file-mode-only edits and deletion paths in the fingerprint", () => {
    const modeOnly = "diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755"
    const deletedOne = "diff --git a/one.ts b/one.ts\ndeleted file mode 100644\n--- a/one.ts\n+++ /dev/null"
    const deletedTwo = "diff --git a/two.ts b/two.ts\ndeleted file mode 100644\n--- a/two.ts\n+++ /dev/null"
    expect(normalizeHardDiff(modeOnly)).toContain("meta:old mode 100644")
    expect(normalizeHardDiff(deletedOne)).not.toBe(normalizeHardDiff(deletedTwo))
  })

  test("preserves quoted paths with spaces", () => {
    const left = 'diff --git "a/src/first file.ts" "b/src/first file.ts"\n@@ -1 +1 @@\n-old()\n+new()'
    const right = 'diff --git "a/src/second file.ts" "b/src/second file.ts"\n@@ -1 +1 @@\n-old()\n+new()'
    expect(normalizeHardDiff(left)).not.toBe(normalizeHardDiff(right))
  })

  test("does not dedupe token boundaries or indentation-sensitive changes", () => {
    const spacedTokens = "--- a/code.ts\n+++ b/code.ts\n@@ -1 +1 @@\n-return a + +b;"
    const joinedOperator = "--- a/code.ts\n+++ b/code.ts\n@@ -1 +1 @@\n-return a++b;"
    const pythonFourSpaces = "--- a/code.py\n+++ b/code.py\n@@ -1 +1,2 @@\n+if enabled:\n+    run()"
    const pythonTwoSpaces = "--- a/code.py\n+++ b/code.py\n@@ -1 +1,2 @@\n+if enabled:\n+  run()"
    expect(normalizeHardDiff(spacedTokens)).not.toBe(normalizeHardDiff(joinedOperator))
    expect(normalizeHardDiff(pythonFourSpaces)).not.toBe(normalizeHardDiff(pythonTwoSpaces))
  })

  test("drops failed attempts and duplicate diffs, then keeps the smallest verified candidate", () => {
    const duplicate = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old()\n+new() // same result"
    const candidates = hardModeFinalists([
      { attempt: 1, verified: true, diff: "--- a/large.ts\n+++ b/large.ts\n@@ -1 +1 @@\n-old()\n+newFunctionWithSeveralMeaningfulParametersAndBranches()", costUSD: 0.1 },
      { attempt: 2, verified: false, diff: "--- a/fail.ts\n+++ b/fail.ts\n@@ -1 +1 @@\n-old()\n+failed()", costUSD: 0.1 },
      { attempt: 3, verified: true, diff: duplicate, costUSD: 0.2 },
      { attempt: 4, verified: true, diff: duplicate.replace(" // same result", " /* duplicate */"), costUSD: 0.1 },
    ])
    expect(candidates.map((item) => item.attempt)).toEqual([4])
  })

  test("keeps equal-size different passing diffs for the Flash tie-break", () => {
    const candidates = hardModeFinalists([
      { attempt: 1, verified: true, diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b", costUSD: 0.1 },
      { attempt: 2, verified: true, diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-c\n+d", costUSD: 0.1 },
    ])
    expect(candidates.map((item) => item.attempt)).toEqual([1, 2])
  })
})
