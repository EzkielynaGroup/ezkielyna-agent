import { describe, expect, test } from "bun:test"
import { defaultProjectPath } from "./onboarding-path"

describe("first-launch default project path", () => {
  test("keeps the Documents location for a normal install", () => {
    expect(defaultProjectPath({ documentsPath: "/Users/test/Documents", userDataPath: "/tmp/profile", hasUserDataOverride: false })).toBe(
      "/Users/test/Documents/Default Project",
    )
  })

  test("keeps a test profile's project inside its user-data directory", () => {
    expect(defaultProjectPath({ documentsPath: "/Users/test/Documents", userDataPath: "/tmp/profile", hasUserDataOverride: true })).toBe(
      "/tmp/profile/Default Project",
    )
  })

  test("falls back to Documents if the override has no resolved user-data path", () => {
    expect(defaultProjectPath({ documentsPath: "/Users/test/Documents", hasUserDataOverride: true })).toBe(
      "/Users/test/Documents/Default Project",
    )
  })
})
