import { describe, expect, test } from "bun:test"
import { brandText } from "../../src/ezkielyna-brand"
import { dict as appEn } from "../../../app/src/i18n/en"
import { dict as appId } from "../../../app/src/i18n/id"
import { dict as uiEn } from "../../../ui/src/i18n/en"
import { dict as uiId } from "../../../ui/src/i18n/id"

// Regression: a repository-wide rename once turned brandText into a no-op (OpenCode -> Ezkielyna Agent inside its own regex), which
// would have shown "OpenCode" in every dialog of the shipped languages.
describe("brandText and the shipped dictionaries", () => {
  test("rewrites the upstream product name", () => {
    expect(brandText("Welcome to OpenCode")).toBe("Welcome to Ezkielyna Agent")
    expect(brandText("OpenCode and OpenCode")).toBe("Ezkielyna Agent and Ezkielyna Agent")
  })

  test("English and Indonesian dictionaries show no upstream name once branded", () => {
    for (const [name, dict] of Object.entries({ appEn, appId, uiEn, uiId })) {
      const leftovers = Object.entries(dict as Record<string, string>)
        .filter(([, value]) => typeof value === "string" && /opencode/i.test(brandText(value)))
        .map(([key]) => key)
      expect({ name, leftovers }).toEqual({ name, leftovers: [] })
    }
  })
})
