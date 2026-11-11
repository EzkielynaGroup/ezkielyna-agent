import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SECRET_SERVICE, createSecretStore, defaultRun, type Run } from "../../src/ezkielyna-secrets"

const KEY = "sk-" + "abcdefghijklmnopqrstuvwxyz0123456789ABCD"

function recorder(result: { status: number; stdout?: string; stderr?: string } = { status: 0, stdout: "", stderr: "" }) {
  const calls: { cmd: string; args: string[]; input?: string }[] = []
  const run: Run = (cmd, args, input) => {
    calls.push({ cmd, args, input })
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  }
  return { calls, run }
}

describe("secret store", () => {
  test("macOS: the key goes through stdin of `security -i`, never argv", () => {
    const { calls, run } = recorder()
    expect(createSecretStore({ platform: "darwin", run }).set("api-key", KEY)).toBe(true)
    expect(calls[0].cmd).toBe("security")
    expect(calls[0].args).toEqual(["-i"])
    expect(calls[0].input).toContain(KEY)
    expect(JSON.stringify(calls[0].args)).not.toContain(KEY)
    expect(calls[0].input).toContain(`"${SECRET_SERVICE}"`)
  })

  test("macOS: reads with find-generic-password -w and trims", () => {
    const { calls, run } = recorder({ status: 0, stdout: `${KEY}\n` })
    expect(createSecretStore({ platform: "darwin", run }).get("api-key")).toBe(KEY)
    expect(calls[0].args).toEqual(["find-generic-password", "-a", "api-key", "-s", SECRET_SERVICE, "-w"])
  })

  test("Linux: secret-tool with the secret on stdin", () => {
    const { calls, run } = recorder()
    createSecretStore({ platform: "linux", run }).set("api-key", KEY)
    expect(calls[0].cmd).toBe("secret-tool")
    expect(calls[0].input).toBe(KEY)
    expect(JSON.stringify(calls[0].args)).not.toContain(KEY)
  })

  test("Windows: PowerShell DPAPI with the secret on stdin", () => {
    const { calls, run } = recorder()
    createSecretStore({ platform: "win32", run, dir: fs.mkdtempSync(path.join(os.tmpdir(), "ezk-dpapi-")) }).set("api-key", KEY)
    expect(calls[0].cmd).toBe("powershell.exe")
    expect(calls[0].input).toBe(KEY)
    expect(calls[0].args.join(" ")).toContain("ProtectedData")
    expect(calls[0].args.join(" ")).not.toContain(KEY)
  })

  test("Windows: DPAPI files stay under the user profile using Windows path rules", () => {
    const { calls, run } = recorder()
    const store = createSecretStore({
      platform: "win32",
      run,
      pathApi: path.win32,
      env: { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" },
      makeDirectory: () => {},
    })

    expect(store.set("api-key", KEY)).toBe(true)
    expect(calls[0].args.join(" ")).toContain("C:\\Users\\owner\\AppData\\Local\\Ezkielyna\\secret-api-key.dpapi")
    expect(calls[0].input).toBe(KEY)
    expect(calls[0].args.join(" ")).not.toContain(KEY)
  })

  test("failure or odd input returns false so the caller keeps the 0600 file fallback", () => {
    expect(createSecretStore({ platform: "darwin", run: recorder({ status: 1, stderr: "denied" }).run }).set("api-key", KEY)).toBe(false)
    expect(createSecretStore({ platform: "darwin", run: recorder().run }).set("api-key", "has space and 'quote")).toBe(false)
    expect(createSecretStore({ platform: "darwin", run: recorder().run }).set("bad account!", KEY)).toBe(false)
    expect(createSecretStore({ platform: "freebsd" as NodeJS.Platform }).set("api-key", KEY)).toBe(false)
    expect(createSecretStore({ disabled: true }).backend).toBe("none")
  })

  test.skipIf(process.platform !== "darwin")("macOS Keychain round trip (real), with cleanup", () => {
    const account = `ezk-test-${Math.random().toString(36).slice(2, 10)}`
    const store = createSecretStore({ platform: "darwin", run: defaultRun })
    try {
      expect(store.set(account, KEY)).toBe(true)
      expect(store.get(account)).toBe(KEY)
    } finally {
      store.delete(account)
    }
    expect(store.get(account)).toBeUndefined()
  })
})
