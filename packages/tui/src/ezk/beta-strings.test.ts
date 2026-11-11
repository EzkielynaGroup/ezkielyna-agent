import { describe, expect, test } from "bun:test"
import { betaT } from "./beta-strings"

describe("beta welcome TUI copy", () => {
  test("shows the same three onboarding actions and report command in English and Indonesian", () => {
    const en = betaT("en")
    expect(en("try.fix")).toContain("fix a bug")
    expect(en("try.tests")).toBe("Run tests")
    expect(en("try.auto")).toContain("Auto")
    expect(en("hint")).toContain("/lapor")

    const id = betaT("id")
    expect(id("try.fix")).toContain("membetulkan bug")
    expect(id("try.tests")).toBe("Jalankan test")
    expect(id("try.auto")).toContain("Auto")
    expect(id("hint")).toContain("/lapor")
  })
})
