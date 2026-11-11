import { expect, test } from "bun:test"
import path from "node:path"

const file = path.join(import.meta.dir, "fixtures", "puisi.txt")
const run = (...args: string[]) => Bun.spawnSync(["bun", path.join(import.meta.dir, "wc.ts"), ...args])

test("flags", () => {
  expect(run(file).stdout.toString().trim()).toBe("11 words")
  expect(run("--lines", file).stdout.toString().trim()).toBe("3 lines")
  expect(run(file, "--lines").stdout.toString().trim()).toBe("3 lines")
  expect(run("--chars", file).stdout.toString().trim()).toBe("79 chars")
})

test("unicode characters are counted once", async () => {
  const tmp = path.join(import.meta.dir, "fixtures", "kopi.txt")
  await Bun.write(tmp, "kopi ☕ é\n")
  expect(run("--chars", tmp).stdout.toString().trim()).toBe("9 chars")
})

test("unknown flag", () => {
  const result = run("--bytes", file)
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString().length).toBeGreaterThan(0)
})
