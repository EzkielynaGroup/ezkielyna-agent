// P6: what `ezkielyna upgrade <version>` accepts, and the reason when it refuses.
import { describe, expect, test } from "bun:test"
import { checkUpgradeTarget } from "../../src/ezk/upgrade-check"

const current = "1.19.3-ezk.6"
const latest = "1.19.3-ezk.7"
const check = (requested: string | undefined, extra: object = {}) => checkUpgradeTarget({ requested, current, latest, hasServer: true, lang: "en", ...extra })

describe("upgrade target", () => {
  test("no version given: the latest signed release", () => {
    expect(check(undefined)).toEqual({ ok: true, target: latest, same: false })
  })

  test("the latest signed release, with or without a leading v", () => {
    expect(check("1.19.3-ezk.7")).toEqual({ ok: true, target: latest, same: false })
    expect(check("v1.19.3-ezk.7")).toEqual({ ok: true, target: latest, same: false })
  })

  test("the installed version is a no-op, not an error", () => {
    expect(check("1.19.3-ezk.6")).toEqual({ ok: true, target: current, same: true })
    expect(check(undefined, { latest: current })).toEqual({ ok: true, target: current, same: true })
  })

  test("a bad version string is refused with the reason", () => {
    for (const bad of ["banana", "1.19", "latest", "1.x", ""]) {
      const result = check(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.kind).toBe("invalid")
        expect(result.reason).toContain(`"${bad}" is not a version number`)
        expect(result.reason).toContain("1.19.3-ezk.6")
      }
    }
  })

  test("an older version is refused: upgrade only moves forward", () => {
    for (const older of ["1.19.3-ezk.4", "1.19.2", "1.0.0"]) {
      const result = check(older)
      expect(result).toMatchObject({ ok: false, kind: "older" })
      if (!result.ok) expect(result.reason).toBe(`${older} is older than the installed ${current}. upgrade only moves forward.`)
    }
  })

  test("a newer version that is not the current signed release is refused and names the latest", () => {
    const result = check("1.19.3-ezk.9")
    expect(result).toMatchObject({ ok: false, kind: "not-current" })
    if (!result.ok) expect(result.reason).toContain("(the latest is 1.19.3-ezk.7)")
  })

  test("a development build (no version number) compares nothing and leaves the rest to the installer", () => {
    expect(checkUpgradeTarget({ requested: "1.0.0", current: "local", latest: "local", hasServer: false, lang: "en" })).toEqual({ ok: true, target: "1.0.0", same: false })
    expect(checkUpgradeTarget({ requested: "banana", current: "local", lang: "en" })).toMatchObject({ ok: false, kind: "invalid" })
  })

  test("Indonesian reasons", () => {
    const result = check("1.0.0", { lang: "id" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("lebih lama dari versi terpasang")
  })
})
