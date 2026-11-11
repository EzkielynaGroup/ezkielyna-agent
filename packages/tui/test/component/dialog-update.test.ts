import { describe, expect, test } from "bun:test"
import { updateTarget } from "../../src/component/dialog-update"
import { isVersionGreater, visibleNotice } from "../../src/context/update-notification"

describe("dialog update (Ezkielyna Agent)", () => {
  test("a strictly newer release is an update", () => {
    expect(updateTarget({ current: "1.4.0", latest: "1.4.2" })).toEqual({ type: "latest", version: "1.4.2" })
    expect(updateTarget({ current: "1.9.0", latest: "1.10.0" })).toEqual({ type: "latest", version: "1.10.0" })
    expect(updateTarget({ current: "1.19.3-ezk.1", latest: "1.19.3-ezk.2" })).toEqual({ type: "latest", version: "1.19.3-ezk.2" })
  })

  test("the same or an older release is not an update, and there is never an 'OpenCode 2' offer", () => {
    expect(updateTarget({ current: "1.4.2", latest: "1.4.2" })).toBeUndefined()
    expect(updateTarget({ current: "1.4.2", latest: "1.4.1" })).toBeUndefined()
    expect(updateTarget({ current: "1.4.2" })).toBeUndefined()
  })

  test("skipping a version hides it until a newer one ships", () => {
    const now = 1_000_000
    expect(visibleNotice({ type: "available", version: "1.4.2" }, {}, now)).toEqual({ type: "available", version: "1.4.2" })
    expect(visibleNotice({ type: "available", version: "1.4.2" }, { skippedVersion: "1.4.2" }, now)).toBeUndefined()
    expect(visibleNotice({ type: "available", version: "1.4.3" }, { skippedVersion: "1.4.2" }, now)).toEqual({ type: "available", version: "1.4.3" })
  })

  test("compares versions for skipping", () => {
    expect(isVersionGreater("1.4.2", "1.4.2")).toBe(false)
    expect(isVersionGreater("1.4.3", "1.4.2")).toBe(true)
    expect(isVersionGreater("1.5.0", "1.10.0")).toBe(false)
    expect(isVersionGreater("1.4.2", "1.4.2-beta.1")).toBe(true)
  })
})
