import { describe, expect, test } from "bun:test"
import { childEnv, scrubChildEnv } from "../../src/ezk/safety/env"

describe("env scrub on Windows", () => {
  test("secret names are matched whatever their case", () => {
    const out = scrubChildEnv({ Path: "C:\\bin", api_key: "x", Github_Token: "y", ComSpec: "cmd.exe" })
    expect(Object.keys(out).sort()).toEqual(["ComSpec", "Path"])
  })
  test("the passthrough list is case-insensitive", () => {
    expect(scrubChildEnv({ My_Token: "z" }, "MY_TOKEN")).toEqual({ My_Token: "z" })
  })
  test("an explicit PATH replaces the inherited Path instead of sitting beside it", () => {
    const out = childEnv({ Path: "C:\\old", TEMP: "C:\\t" }, { PATH: "C:\\new" }, undefined, "win32")
    expect(out).toEqual({ TEMP: "C:\\t", PATH: "C:\\new" })
  })
  test("on POSIX the two names stay distinct", () => {
    const out = childEnv({ Path: "a" }, { PATH: "b" }, undefined, "linux")
    expect(out).toEqual({ Path: "a", PATH: "b" })
  })
})
