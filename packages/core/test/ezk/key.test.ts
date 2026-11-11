import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readGatewayKey } from "../../src/ezk/key"
import { SECRET_SENTINEL } from "../../src/ezkielyna-secrets"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("readGatewayKey", () => {
  test("resolves a keychain sentinel through readLocalKey", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-key-"))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ ezkielyna: { type: "api", key: SECRET_SENTINEL } }))
    const secretStore = { get: (account: string) => (account === "api-key" ? "sk-" + "in-memory-secret" : undefined) }

    expect(readGatewayKey(dir, {}, secretStore)).toBe("sk-" + "in-memory-secret")
  })

  test("uses the explicit environment key before the auth file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-key-"))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ ezkielyna: { type: "api", key: SECRET_SENTINEL } }))

    expect(readGatewayKey(dir, { EZKIELYNA_API_KEY: "sk-env-key" }, { get: () => "sk-stored-key" })).toBe("sk-env-key")
  })
})
