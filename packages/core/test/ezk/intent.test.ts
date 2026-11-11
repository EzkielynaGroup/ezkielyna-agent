import { describe, expect, test } from "bun:test"
import { classifyIntent } from "../../src/ezk/intent/classify"
import { isFixIntent } from "../../src/ezk/context/reproduce"
import { questionOnly } from "../../src/ezk/loop/policy"

describe("shared offline intent detector", () => {
  test("distinguishes bug repairs, planning, information requests, and ordinary work", () => {
    expect(classifyIntent("Tests are failing after the merge; please fix the regression.")).toBe("fix")
    expect(classifyIntent("Buat rencana dulu untuk migrasi database tanpa downtime.")).toBe("plan-needed")
    expect(classifyIntent("What does the --plan flag do? Explain briefly.")).toBe("qa")
    expect(classifyIntent("Add a small duration formatter with one unit test.")).toBe("other")
  })

  test("pure questions mentioning fixes do not trigger A10 or A5", () => {
    for (const prompt of ["How do I fix this?", "Kenapa test checkout gagal terus?", "Why does this Windows path fail?"]) {
      expect(classifyIntent(prompt)).toBe("qa")
      expect(questionOnly(prompt)).toBe(true)
      expect(isFixIntent(prompt)).toBe(false)
    }
  })

  test("explicit repair requests and failures still trigger reproduce-first", () => {
    for (const prompt of ["Can you fix this?", "The build is broken after the merge.", "Jalankan test lalu perbaiki regresinya."]) {
      expect(classifyIntent(prompt)).toBe("fix")
      expect(isFixIntent(prompt)).toBe(true)
      expect(questionOnly(prompt)).toBe(false)
    }
  })

  test("read-only review and tiny edits keep their intent", () => {
    expect(classifyIntent("Review PR #123 and report only blocking issues; jangan edit file.")).toBe("qa")
    expect(classifyIntent("Fix the typo in README.")).toBe("other")
    expect(classifyIntent("Review this PR across packages for security risks before merge.")).toBe("plan-needed")
  })

  test("polite explain-requests about a failure stay qa (review L-3); a polite fix request still fixes", () => {
    expect(classifyIntent("can you explain the crash in foo.ts")).toBe("qa")
    expect(classifyIntent("could you describe why the build fails")).toBe("qa")
    expect(classifyIntent("can you please fix the crash in foo.ts")).toBe("fix")
  })
})
