import { describe, expect, test } from "bun:test"
import { MINIMUM_BUN, assertMinimumBun } from "../../script/require-bun"

describe("release build Bun guard", () => {
  test("accepts the minimum and newer versions", () => {
    expect(() => assertMinimumBun(MINIMUM_BUN)).not.toThrow()
    expect(() => assertMinimumBun("1.4.10")).not.toThrow()
    expect(() => assertMinimumBun("2.0.0")).not.toThrow()
  })

  test("rejects older Bun with a message that names the fix", () => {
    for (const version of ["1.3.14", "1.4.2", "1.0.0"]) {
      expect(() => assertMinimumBun(version)).toThrow(/needs Bun 1\.4\.3 or newer \(found .+\).*bun upgrade/s)
    }
  })

  test("build.ts runs the guard before anything else", async () => {
    const source = await Bun.file(new URL("../../script/build.ts", import.meta.url)).text()
    expect(source).toContain('import { assertMinimumBun } from "./require-bun"')
    expect(source.indexOf("assertMinimumBun()")).toBeGreaterThan(-1)
    expect(source.indexOf("assertMinimumBun()")).toBeLessThan(source.indexOf("await import(\"./generate.ts\")"))
  })
})
