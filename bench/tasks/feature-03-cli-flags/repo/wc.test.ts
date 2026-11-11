import { expect, test } from "bun:test"
import path from "node:path"

const run = (...args: string[]) => Bun.spawnSync(["bun", path.join(import.meta.dir, "wc.ts"), ...args])

test("counts words", () => {
  const file = path.join(import.meta.dir, "fixtures", "puisi.txt")
  expect(run(file).stdout.toString().trim()).toBe("11 words")
})
