import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { afterEach, describe, expect, test } from "bun:test"
import { flags, resetFlagsCache } from "../../src/ezk/safety"
import { childEnv, scrubChildEnv } from "../../src/ezk/safety/env"
import { isProtectedPath, protectedPathMentions } from "../../src/ezk/safety/protected-paths"

afterEach(resetFlagsCache)

test("global flags cache parses unchanged config once across repeated permission checks and reloads on mtime change", () => {
  const file = path.join(Global.Path.config, "ezkielyna.json")
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ezk: { modes: { enabled: false } } }))
    resetFlagsCache()
    const first = flags()
    for (let i = 0; i < 1000; i++) expect(flags()).toBe(first)

    fs.writeFileSync(file, JSON.stringify({ ezk: { modes: { enabled: true } } }))
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(file, future, future)
    expect(flags().modes.enabled).toBe(true)
  } finally {
    if (original === undefined) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, original)
    resetFlagsCache()
  }
})

describe("protected paths across platform path forms", () => {
  const protectedNames = [".git", ".ezkielyna", ".claude", ".codex", ".agents", ".aws", ".ssh"]

  test.each(protectedNames)("protects %s on macOS/POSIX paths", (name) => {
    expect(isProtectedPath("/work/project", `/work/project/${name}/config`, "posix")).toBe(true)
    expect(isProtectedPath("/work/project", `/work/project/src/${name}/config`, "posix")).toBe(true)
    expect(isProtectedPath("/work/project", `/work/project/src/${name}x/config`, "posix")).toBe(false)
  })

  test.each(protectedNames)("protects %s on Linux/POSIX paths", (name) => {
    expect(isProtectedPath("/srv/app", `/srv/app/${name}/config`, "posix")).toBe(true)
  })

  test.each(protectedNames)("protects %s on Windows paths, case-insensitively", (name) => {
    expect(isProtectedPath("C:\\Work\\Project", `c:\\work\\project\\${name.toUpperCase()}\\config`, "win32")).toBe(true)
  })

  test("recognizes shell writes through redirects and Windows command tokens", () => {
    expect(protectedPathMentions("/work/project", "/work/project", "echo secret > .git/config", "posix")).toBe(true)
    expect(
      protectedPathMentions(
        "/work/project",
        "/work/project",
        `python -c "open('.git/config', 'w').write('x')"`,
        "posix",
      ),
    ).toBe(true)
    expect(protectedPathMentions("C:\\Work\\Project", "C:\\Work\\Project", 'Set-Content .ssh\\id "x"', "win32")).toBe(true)
    expect(protectedPathMentions("/work/project", "/work/project", "echo ok > src/output.txt", "posix")).toBe(false)
  })
})

describe("child process environment scrub", () => {
  test("removes secret-like names, including gateway and server credentials", () => {
    const env = scrubChildEnv({
      PATH: "/bin",
      EZK_SERVER_PASSWORD: "private",
      EZKIELYNA_API_KEY: "private",
      GITHUB_TOKEN: "private",
      SERVICE_SECRET: "private",
      DB_PASSWORD: "private",
      LANG: "id_ID.UTF-8",
    })
    expect(env).toEqual({ PATH: "/bin", LANG: "id_ID.UTF-8" })
  })

  test("allows an explicit comma-separated passthrough override", () => {
    const env = scrubChildEnv({
      EZK_ENV_PASSTHROUGH: "GITHUB_TOKEN, EZK_SERVER_PASSWORD",
      GITHUB_TOKEN: "mock-token",
      EZK_SERVER_PASSWORD: "mock-password",
      EZKIELYNA_API_KEY: "still-secret",
    })
    expect(env).toEqual({ GITHUB_TOKEN: "mock-token", EZK_SERVER_PASSWORD: "mock-password" })
  })

  test("keeps variables the user configured on purpose (MCP environment block, shell.env hook), scrubs only what is inherited", () => {
    const env = childEnv(
      { PATH: "/bin", GITHUB_TOKEN: "inherited", EZKIELYNA_API_KEY: "inherited", DB_PASSWD: "inherited" },
      { GITHUB_PERSONAL_ACCESS_TOKEN: "configured", API_KEY: "configured", EXTRA: "1" },
    )
    expect(env).toEqual({ PATH: "/bin", GITHUB_PERSONAL_ACCESS_TOKEN: "configured", API_KEY: "configured", EXTRA: "1" })
  })

  test("an explicit value replaces an inherited one of the same name; the passthrough list still works", () => {
    expect(childEnv({ API_KEY: "inherited" }, { API_KEY: "configured" })).toEqual({ API_KEY: "configured" })
    expect(childEnv({ GITHUB_TOKEN: "inherited", EZK_ENV_PASSTHROUGH: "GITHUB_TOKEN" }, {})).toEqual({ GITHUB_TOKEN: "inherited" })
  })
})
