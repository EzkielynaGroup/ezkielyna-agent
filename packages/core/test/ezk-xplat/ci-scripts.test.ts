// Guards for the CI smoke scripts (scripts/ci). They only run on CI runners, so a rule that breaks them is invisible until a
// run fails; these pin the rules that already did.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { isSecretName, safeEnv } from "../../../../scripts/ci/safe-env"

const ci = path.resolve(import.meta.dir, "../../../../scripts/ci")

describe("CI smoke environment filter", () => {
  test("drops names that look like credentials", () => {
    const env = safeEnv({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      OPENAI_API_KEY: "x",
      ANTHROPIC_API_KEY: "x",
      GITHUB_TOKEN: "x",
      NPM_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      DB_PASSWORD: "x",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OPENCODE_AUTH_CONTENT: "{}",
      UNSET: undefined,
    })
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"])
  })

  // `xvfb-run -a` exports DISPLAY plus XAUTHORITY (the cookie file of its private X server). The filter used to drop XAUTHORITY
  // because the name contains AUTH, so every Electron smoke on Linux failed with "Authorization required, but no authorization
  // protocol specified" and "The platform failed to initialize".
  test("keeps what Electron needs to reach xvfb-run's X server", () => {
    const env = safeEnv({ DISPLAY: ":99", XAUTHORITY: "/tmp/xvfb-run.AbCdEf/Xauthority", XDG_RUNTIME_DIR: "/run/user/1001" })
    expect(env).toEqual({ DISPLAY: ":99", XAUTHORITY: "/tmp/xvfb-run.AbCdEf/Xauthority", XDG_RUNTIME_DIR: "/run/user/1001" })
    expect(isSecretName("XAUTHORITY")).toBe(false)
    expect(isSecretName("SSH_AUTH_SOCK")).toBe(true)
  })

  test("every smoke script that filters its environment shares this one rule", () => {
    const scripts = fs.readdirSync(ci).filter((name) => name.endsWith(".ts") && name !== "safe-env.ts")
    const users = scripts.filter((name) => fs.readFileSync(path.join(ci, name), "utf8").includes("safeEnv("))
    expect(users.length).toBeGreaterThan(0)
    for (const name of users) {
      const source = fs.readFileSync(path.join(ci, name), "utf8")
      expect({ name, imported: source.includes('import { safeEnv } from "./safe-env"') }).toEqual({ name, imported: true })
      expect({ name, ownCopy: /function safeEnv\b|API\[_-\]\?KEY/.test(source) }).toEqual({ name, ownCopy: false })
    }
  })
})
