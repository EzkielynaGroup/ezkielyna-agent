import { describe, expect, test } from "bun:test"
import { desktopWindowTitle, resolveTestProfile } from "./test-profile"

describe("test profile marker", () => {
  test("keeps the default install unmarked", () => {
    const profile = resolveTestProfile({})
    expect(profile).toEqual({ enabled: false, apiHost: "api.ezkielyna.store" })
    expect(desktopWindowTitle(profile)).toBe("Ezkielyna Agent")
  })

  test("marks a separate user-data directory and shows only the API host", () => {
    const profile = resolveTestProfile({ EZK_USER_DATA_DIR: "/tmp/ezk-profile", EZKIELYNA_BASE_URL: "" })
    expect(profile).toEqual({ enabled: true, apiHost: "api.ezkielyna.store" })
    expect(desktopWindowTitle(profile)).toBe("Ezkielyna Agent — Profil uji")
  })

  test("marks a custom gateway and strips URL credentials from its hover host", () => {
    expect(resolveTestProfile({ EZKIELYNA_BASE_URL: "https://tester:sk-test_profile@gateway.example.test:8443/api/v1" })).toEqual({
      enabled: true,
      apiHost: "gateway.example.test:8443",
    })
  })

  test("treats a trailing slash on the default URL as the same endpoint", () => {
    expect(resolveTestProfile({ EZKIELYNA_BASE_URL: `${"https://api.ezkielyna.store/v1"}/` }).enabled).toBe(false)
  })
})
