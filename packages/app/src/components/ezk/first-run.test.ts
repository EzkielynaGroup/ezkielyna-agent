import { describe, expect, test } from "bun:test"
import { classifyDesktopEzkKeyError, ezkielynaKeyAction, hasEzkielynaCredential, shouldOpenFirstRun } from "./first-run"

describe("Ezkielyna first-run credential state", () => {
  test("requires a real credential and treats an environment source as configured", () => {
    expect(hasEzkielynaCredential(undefined)).toBe(false)
    expect(hasEzkielynaCredential({ source: "config" })).toBe(false)
    expect(hasEzkielynaCredential({ source: "api", key: "  " })).toBe(false)
    expect(hasEzkielynaCredential({ source: "api", key: "sk-test_fake-1234" })).toBe(true)
    expect(hasEzkielynaCredential({ source: "config", key: "configured-key" })).toBe(true)
    expect(hasEzkielynaCredential({ source: "env" })).toBe(true)
  })

  test("opens only after provider data is ready and only once per app session", () => {
    expect(shouldOpenFirstRun({ ready: false, hasCredential: false, alreadyOpened: false })).toBe(false)
    expect(shouldOpenFirstRun({ ready: true, hasCredential: true, alreadyOpened: false })).toBe(false)
    expect(shouldOpenFirstRun({ ready: true, hasCredential: false, alreadyOpened: true })).toBe(false)
    expect(shouldOpenFirstRun({ ready: true, hasCredential: false, alreadyOpened: false })).toBe(true)
    // protocol v2 (or not detected yet): the provider list cannot say whether a key exists
    expect(shouldOpenFirstRun({ ready: true, hasCredential: false, alreadyOpened: false, credentialKnown: false })).toBe(false)
    expect(shouldOpenFirstRun({ ready: true, hasCredential: false, alreadyOpened: false, credentialKnown: true })).toBe(true)
  })

  test("keeps a direct connect action available for config and environment providers", () => {
    expect(ezkielynaKeyAction({ source: "config", key: "configured-key" })).toBe("connect")
    expect(ezkielynaKeyAction({ source: "env" })).toBe("connect")
    expect(ezkielynaKeyAction({ source: "api", key: "sk-test_fake-1234" })).toBe("change")
    expect(ezkielynaKeyAction(undefined)).toBe("connect")
  })

  test("replaces desktop bad-key advice with a useful action and leaves unrelated errors alone", () => {
    expect(classifyDesktopEzkKeyError("The API key is invalid, deleted, or out of balance. Enter it again with /connect.", false)).toBe("missing-key")
    expect(classifyDesktopEzkKeyError("No auth configured for provider ezkielyna.", false)).toBe("missing-key")
    expect(classifyDesktopEzkKeyError("Kunci API tidak valid. Masukkan lagi dengan /connect.", false)).toBe("missing-key")
    expect(classifyDesktopEzkKeyError("The API key is invalid, deleted, or out of balance.", true)).toBe("invalid-key")
    expect(classifyDesktopEzkKeyError("Cannot reach api.ezkielyna.store.", false)).toBeUndefined()
  })
})
