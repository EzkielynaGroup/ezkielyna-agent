import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  TREE_MAX_LINES,
  buildSessionStart,
  buildTree,
  detectToolchain,
  detectVerify,
  resetSessionStartCache,
} from "../../src/ezk/context/session-start"
import { REPRODUCE_BLOCK, isFixIntent } from "../../src/ezk/context/reproduce"

let dir: string
const w = (rel: string, content = "") => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content)
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-ctx-"))
  resetSessionStartCache()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("A9 tree", () => {
  test("depth 2, dirs first, .gitignore and node_modules hidden", () => {
    w(".gitignore", "secret/\n*.log\n/out\n")
    w("src/a.ts")
    w("src/deep/b.ts")
    w("secret/x")
    w("out/y")
    w("node_modules/z/index.js")
    w("run.log")
    w("README.md")
    const tree = buildTree(dir)
    expect(tree).toContain("src/")
    expect(tree).toContain("  a.ts")
    expect(tree).not.toContain("b.ts") // depth 3
    expect(tree).not.toContain("secret")
    expect(tree).not.toContain("out")
    expect(tree).not.toContain("node_modules")
    expect(tree).not.toContain("run.log")
    expect(tree.indexOf("src/")).toBeLessThan(tree.indexOf("README.md"))
  })

  test("never more than 40 lines", () => {
    for (let i = 0; i < 30; i++) for (let j = 0; j < 8; j++) w(`d${String(i).padStart(2, "0")}/f${j}.txt`)
    for (let i = 0; i < 50; i++) w(`top${i}.txt`)
    const lines = buildTree(dir).split("\n")
    expect(lines.length).toBeLessThanOrEqual(TREE_MAX_LINES)
  })

  test("empty folder gives no tree", () => expect(buildTree(dir)).toBe(""))
})

describe("A9 toolchain", () => {
  test("versions parsed, missing tools skipped, package manager from lockfile", async () => {
    w("package.json", "{}")
    w("bun.lock", "")
    const calls: string[] = []
    const exec = async (cmd: string) => {
      calls.push(cmd)
      if (cmd === "node") return "v22.4.1\n"
      if (cmd === "bun") return "1.3.14\n"
      if (cmd === "go") return "go version go1.23.1 darwin/arm64"
      return undefined
    }
    const t = await detectToolchain(dir, { sessionID: "s1", exec })
    expect(t).toMatchObject({ node: "22.4.1", bun: "1.3.14", go: "1.23.1", packageManager: { name: "bun", version: "1.3.14" } })
    expect(t.python).toBeUndefined()
  })

  test("cached per session; a new session probes again", async () => {
    let n = 0
    const exec = async () => (n++, "1.0.0")
    await detectToolchain(dir, { sessionID: "a", exec })
    const after = n
    await detectToolchain(dir, { sessionID: "a", exec })
    expect(n).toBe(after)
    await detectToolchain(dir, { sessionID: "b", exec })
    expect(n).toBeGreaterThan(after)
  })

  test("a hanging probe is cut at the 1 s timeout passed to exec", async () => {
    const seen: number[] = []
    await detectToolchain(dir, { sessionID: "t", exec: async (_c, _a, o) => (seen.push(o.timeoutMs), undefined) })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((x) => x === 1000)).toBe(true)
  })
})

describe("A9 verify command (ezk.verify)", () => {
  test("package.json scripts: typecheck, lint, test with the package manager", () => {
    w("package.json", JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc --noEmit", lint: "eslint ." } }))
    w("bun.lock", "")
    const v = detectVerify(dir)!
    expect(v.source).toBe("package.json")
    expect(v.command).toBe("bun run typecheck && bun run lint && bun test")
  })

  test("npm placeholder test script is ignored", () => {
    w("package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
    expect(detectVerify(dir)).toBeUndefined()
  })

  test("Makefile, pytest, cargo, go", () => {
    w("Makefile", "build:\n\tcc x\ntest:\n\t./t\n")
    expect(detectVerify(dir)?.command).toBe("make test")
    for (const [file, content, cmd] of [
      ["pytest.ini", "[pytest]", "pytest -q"],
      ["Cargo.toml", "[package]", "cargo test"],
      ["go.mod", "module x", "go test ./..."],
    ] as const) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-v-"))
      fs.writeFileSync(path.join(d, file), content)
      expect(detectVerify(d)?.command).toBe(cmd)
      fs.rmSync(d, { recursive: true })
    }
  })

  test("nothing detected -> undefined", () => expect(detectVerify(dir)).toBeUndefined())
})

describe("A9 reminder text", () => {
  test("contains tree, toolchain and verify; undefined for an empty folder with no tools", async () => {
    w("package.json", JSON.stringify({ scripts: { test: "vitest" } }))
    w("src/a.ts")
    const text = (await buildSessionStart(dir, { sessionID: "x", exec: async (c) => (c === "node" ? "v20.1.0" : undefined) }))!
    expect(text).toContain("<session_start_context>")
    expect(text).toContain("src/")
    expect(text).toContain("node 20.1.0")
    expect(text).toContain("Verify command: npm test")
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-e-"))
    expect(await buildSessionStart(empty, { sessionID: "y", exec: async () => undefined })).toBeUndefined()
    fs.rmSync(empty, { recursive: true })
  })
})

describe("A10 reproduce-first", () => {
  test("block is short (<120 tokens ~ <480 chars) and states the protocol", () => {
    expect(REPRODUCE_BLOCK.length).toBeLessThan(480)
    expect(REPRODUCE_BLOCK).toContain("failing reproduction")
    expect(REPRODUCE_BLOCK).toContain("file, then function, then lines")
    expect(REPRODUCE_BLOCK).toContain("one minimal change")
  })
  test("fix prompts match", () => {
    for (const p of [
      "Fix the crash when the user logs out",
      "the build is broken after the merge",
      "tests are failing in auth.test.ts",
      "perbaiki bug di halaman login",
      "this throws an exception on empty input, please fix",
      "fix typo bug in parser that crashes",
    ])
      expect(isFixIntent(p)).toBe(true)
  })
  test("non-fix prompts do not match", () => {
    for (const p of [
      "Add a new endpoint for invoices",
      "fix the typo in the README",
      "format the code with prettier",
      "explain how the router works",
      "why does this fail?",
      "",
      "rename foo to bar",
    ])
      expect(isFixIntent(p)).toBe(false)
  })
})

describe("M11 untrusted folders", () => {
  test("no probe runs in the repo; the package-manager probe needs trust", async () => {
    w("package.json", "{}")
    w("yarn.lock", "")
    const calls: { cmd: string; cwd: string }[] = []
    const exec = async (cmd: string, _a: string[], o: { cwd: string }) => (calls.push({ cmd, cwd: o.cwd }), "1.2.3")
    await detectToolchain(dir, { sessionID: "u1", exec })
    expect(calls.some((c) => c.cmd === "yarn")).toBe(false)
    expect(calls.every((c) => c.cwd !== dir)).toBe(true)
    calls.length = 0
    await detectToolchain(dir, { sessionID: "u1", exec, trusted: true })
    expect(calls.find((c) => c.cmd === "yarn")?.cwd).toBe(dir)
    expect(calls.filter((c) => c.cmd !== "yarn").every((c) => c.cwd !== dir)).toBe(true)
  })
})
