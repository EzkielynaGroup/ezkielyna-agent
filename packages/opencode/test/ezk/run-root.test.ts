import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runRoot } from "../../src/ezk/run-root"

describe("run's project folder (Bench v2: $PWD of the caller must not win)", () => {
  test("the real working directory comes first, a stale $PWD is ignored", () => {
    expect(runRoot({ PWD: "/some/caller/folder" }, () => "/real/target")).toBe(path.resolve("/real/target"))
  })
  test("$PWD is only a fallback when the working directory cannot be read", () => {
    const gone = () => {
      throw new Error("ENOENT: cwd gone")
    }
    expect(runRoot({ PWD: "/fallback" }, gone)).toBe(path.resolve("/fallback"))
  })
  test("a child started with a cwd option works in that folder although it inherits the caller's PWD", () => {
    const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-runroot-")))
    try {
      const code = `import { runRoot } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/ezk/run-root.ts"))}; console.log(runRoot())`
      const out = Bun.spawnSync([process.execPath, "-e", code], { cwd: target, env: { ...process.env, PWD: process.cwd() } })
      expect(out.stdout.toString().trim()).toBe(target)
    } finally {
      fs.rmSync(target, { recursive: true, force: true })
    }
  })
})
