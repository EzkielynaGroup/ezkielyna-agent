// C1: "no key yet" is not "the key was refused"; /connect only exists inside the TUI; doctor shows where to get a key.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { classifyGatewayError, detectSurface, friendlyGatewayError, noKeyMessage } from "../../src/ezkielyna-errors"
import { hasLocalCredential, localCredentialState } from "../../src/ezkielyna-localkey"
import { SECRET_SENTINEL } from "../../src/ezkielyna-secrets"
import { renderDoctor, runDoctor, type DoctorDeps } from "../../src/ezk/diag/doctor"

const BAD_KEY = '{"error":{"code":"","message":"Invalid token (request id: 2026)","type":"new_api_error"}}'
const EN = "No API key yet. Get one at https://api.ezkielyna.store/keys, then run: ezkielyna auth login"
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-nokey-"))
  dirs.push(d)
  return d
}

describe("no key yet (C1)", () => {
  test("401 with no credential says there is no key, with the keys URL and the command", () => {
    expect(classifyGatewayError({ status: 401, responseBody: BAD_KEY }, { hasKey: false })?.kind).toBe("no_key")
    expect(friendlyGatewayError({ status: 401, responseBody: BAD_KEY }, "en", { hasKey: false, surface: "cli" })).toBe(
      EN,
    )
    expect(friendlyGatewayError({ status: 401, responseBody: BAD_KEY }, "id", { hasKey: false, surface: "cli" })).toBe(
      "Belum ada kunci API. Dapatkan di https://api.ezkielyna.store/keys, lalu jalankan: ezkielyna auth login",
    )
    expect(noKeyMessage("en", "cli")).toBe(EN)
  })

  test("never says invalid / deleted / out of balance when there is no credential", () => {
    for (const lang of ["en", "id"] as const) {
      const text = friendlyGatewayError({ status: 401, responseBody: BAD_KEY }, lang, {
        hasKey: false,
        surface: "tui",
      })!
      expect(text).not.toMatch(/invalid|deleted|out of balance|tidak valid|dihapus|habis/i)
    }
  })

  test("with a credential the bad-key text stays, and /connect is named only in the TUI", () => {
    const cli = friendlyGatewayError({ status: 401, responseBody: BAD_KEY }, "en", { hasKey: true, surface: "cli" })!
    expect(cli).toContain("invalid, deleted, or out of balance")
    expect(cli).not.toContain("/connect")
    expect(cli).toContain("ezkielyna auth login")
    const tui = friendlyGatewayError({ status: 401, responseBody: BAD_KEY }, "en", { hasKey: true, surface: "tui" })!
    expect(tui).toContain("/connect")
    expect(tui).not.toContain("ezkielyna auth login")
    expect(friendlyGatewayError({ status: 401, responseBody: BAD_KEY }, "en", { surface: "cli" })).toContain(
      "invalid, deleted",
    )
  })

  test("no /connect in any command-line text, in either language", () => {
    for (const lang of ["en", "id"] as const) {
      for (const ctx of [{ hasKey: false }, { hasKey: true }] as const) {
        expect(
          friendlyGatewayError({ status: 401, responseBody: BAD_KEY }, lang, { ...ctx, surface: "cli" }),
        ).not.toContain("/connect")
      }
    }
    expect(detectSurface({})).toBe("cli")
    expect(detectSurface({ EZK_SURFACE: "tui" })).toBe("tui")
  })

  test("hasLocalCredential: env var, auth.json entry (keychain sentinel counts), nothing", () => {
    const dataDir = tmp()
    expect(hasLocalCredential({ dataDir, env: {} })).toBe(false)
    expect(hasLocalCredential({ dataDir, env: { EZKIELYNA_API_KEY: "sk-test_abc" } })).toBe(true)
    expect(hasLocalCredential({ dataDir, env: { EZKIELYNA_API_KEY: "  " } })).toBe(false)
    fs.writeFileSync(path.join(dataDir, "auth.json"), JSON.stringify({ openai: { type: "api", key: "sk-test_other" } }))
    expect(hasLocalCredential({ dataDir, env: {} })).toBe(false)
    fs.writeFileSync(
      path.join(dataDir, "auth.json"),
      JSON.stringify({ ezkielyna: { type: "api", key: "ezk-keychain:v1" } }),
    )
    expect(hasLocalCredential({ dataDir, env: {} })).toBe(true)
    fs.writeFileSync(path.join(dataDir, "auth.json"), JSON.stringify({ ezkielyna: { type: "api", key: "" } }))
    expect(hasLocalCredential({ dataDir, env: {} })).toBe(false)
    fs.writeFileSync(path.join(dataDir, "auth.json"), "not json")
    expect(hasLocalCredential({ dataDir, env: {} })).toBe(false)
    expect(
      hasLocalCredential({
        dataDir,
        env: { OPENCODE_AUTH_CONTENT: JSON.stringify({ ezkielyna: { type: "api", key: "sk-test_x" } }) },
      }),
    ).toBe(true)
  })

  test("credential state tells a keychain that cannot be read apart from no key at all", () => {
    const dataDir = tmp()
    const store = (value: string | undefined) => ({ get: () => value })
    expect(localCredentialState({ dataDir, env: {}, secretStore: store("x") })).toBe("none")
    fs.writeFileSync(
      path.join(dataDir, "auth.json"),
      JSON.stringify({ ezkielyna: { type: "api", key: "sk-test_plain" } }),
    )
    expect(localCredentialState({ dataDir, env: {}, secretStore: store(undefined) })).toBe("file")
    fs.writeFileSync(
      path.join(dataDir, "auth.json"),
      JSON.stringify({ ezkielyna: { type: "api", key: SECRET_SENTINEL } }),
    )
    expect(localCredentialState({ dataDir, env: {}, secretStore: store("sk-test_real") })).toBe("keychain")
    expect(localCredentialState({ dataDir, env: {}, secretStore: store(undefined) })).toBe("keychain-unreadable")
    expect(
      localCredentialState({ dataDir, env: { EZKIELYNA_API_KEY: "sk-test_env" }, secretStore: store(undefined) }),
    ).toBe("env")
  })

  test("doctor: a key that is saved but unreadable is reported as such, not as 'not found'", async () => {
    const deps: DoctorDeps = {
      version: "x",
      key: () => ({ present: false, reason: "keychain-unreadable" }),
      models: async () => ({ ok: false, ms: 0, ids: [] }),
      configSources: () => [],
      trust: () => ({ dir: "/p", trusted: true }),
      diskFreeBytes: () => 10 * 1024 ** 3,
      dataDir: "/d",
      updateURL: "",
    }
    const en = renderDoctor(await runDoctor(deps, "en"))
    expect(en).toContain("keychain")
    expect(en).toContain("could not be read")
    expect(en).not.toContain("not found. Get one")
    const id = renderDoctor(await runDoctor(deps, "id"))
    expect(id).toContain("tidak bisa dibaca")
  })

  test("doctor: the 'API key not found' line includes the keys URL and the login command", async () => {
    const deps: DoctorDeps = {
      version: "x",
      key: () => ({ present: false }),
      models: async () => ({ ok: false, ms: 0, ids: [] }),
      configSources: () => [],
      trust: () => ({ dir: "/p", trusted: true }),
      diskFreeBytes: () => 10 * 1024 ** 3,
      dataDir: "/d",
      updateURL: "",
    }
    const en = renderDoctor(await runDoctor(deps, "en"))
    expect(en).toContain("https://api.ezkielyna.store/keys")
    expect(en).toContain("ezkielyna auth login")
    const id = renderDoctor(await runDoctor(deps, "id"))
    expect(id).toContain("https://api.ezkielyna.store/keys")
  })
})
