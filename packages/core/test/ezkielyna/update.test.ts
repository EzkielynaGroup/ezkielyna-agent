import { describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import {
  UPDATE_KEY_ID,
  UPDATE_PUBLIC_KEY_PEM,
  UpdateRejected,
  assertSecureBase,
  cliPlatformKey,
  compareVersions,
  fetchVerifiedManifest,
  isNewer,
  keyId,
  parseManifest,
  verifyBytes,
  verifySignature,
  type FetchLike,
} from "../../src/ezkielyna-update"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
const signWith = (data: string, key = pair.privateKey) => sign("sha256", Buffer.from(data), { key, dsaEncoding: "der" })
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

const manifest = (version: string, extra: object = {}) =>
  JSON.stringify({
    version,
    downloads: {
      desktop: { "win-x64": { exe: { file: `ezkielyna-agent-${version}-win-x64.exe`, sha256: sha("exe"), size: 3 } } },
      cli: { "linux-x64": { file: `ezkielyna-${version}-linux-x64.tar.gz`, sha256: sha("cli"), size: 3 } },
    },
    ...extra,
  })

function server(files: Record<string, Uint8Array | string>): FetchLike {
  return async (url) => {
    const name = url.split("/").pop() as string
    const body = files[name]
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      arrayBuffer: async () => new Uint8Array(typeof body === "string" ? Buffer.from(body) : (body ?? new Uint8Array())).buffer as ArrayBuffer,
    }
  }
}
const BASE = "https://ezkielyna.store/agent/update"

describe("update verifier", () => {
  test("the embedded public key has the documented key id", () => {
    expect(keyId(UPDATE_PUBLIC_KEY_PEM)).toBe(UPDATE_KEY_ID)
  })

  test("accepts a correctly signed, newer manifest", async () => {
    const body = manifest("1.20.0-ezk.1")
    const r = await fetchVerifiedManifest({ base: BASE, currentVersion: "1.19.3-ezk.1", pem, fetch: server({ "latest.json": body, "latest.json.sig": signWith(body) }) })
    expect(r.manifest.version).toBe("1.20.0-ezk.1")
  })

  test("refuses missing, wrong-key and tampered signatures", async () => {
    const body = manifest("1.20.0")
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const go = (files: Record<string, Uint8Array | string>) => fetchVerifiedManifest({ base: BASE, currentVersion: "1.19.3", pem, fetch: server(files) })
    await expect(go({ "latest.json": body })).rejects.toMatchObject({ reason: "fetch_failed" })
    await expect(go({ "latest.json": body, "latest.json.sig": signWith(body, other.privateKey) })).rejects.toMatchObject({ reason: "bad_signature" })
    await expect(go({ "latest.json": body.replace("1.20.0", "9.9.9"), "latest.json.sig": signWith(body) })).rejects.toMatchObject({ reason: "bad_signature" })
    await expect(go({ "latest.json": body, "latest.json.sig": new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({ reason: "bad_signature" })
  })

  test("refuses downgrades and the same version, even when correctly signed", async () => {
    for (const v of ["1.19.3-ezk.1", "1.19.2", "1.19.3-ezk.0", "1.18.0"]) {
      const body = manifest(v)
      await expect(
        fetchVerifiedManifest({ base: BASE, currentVersion: "1.19.3-ezk.1", pem, fetch: server({ "latest.json": body, "latest.json.sig": signWith(body) }) }),
      ).rejects.toMatchObject({ reason: "not_newer" })
    }
  })

  test("HTTPS only, and only our host", () => {
    expect(() => assertSecureBase("http://ezkielyna.store/agent/update")).toThrow(UpdateRejected)
    expect(() => assertSecureBase("https://evil.example/agent/update")).toThrow(UpdateRejected)
    expect(() => assertSecureBase("https://ezkielyna.store.evil.example/x")).toThrow(UpdateRejected)
    expect(assertSecureBase("https://ezkielyna.store/agent/update/")).toBe("https://ezkielyna.store/agent/update")
  })

  test("manifest file names cannot escape the update directory", () => {
    const bad = (file: string) => manifest("1.20.0", { downloads: { desktop: {}, cli: { "linux-x64": { file, sha256: sha("x"), size: 1 } } } })
    for (const file of ["../evil", "a/b", "https://x/y", "..", "a b"]) expect(() => parseManifest(bad(file))).toThrow(UpdateRejected)
    expect(() => parseManifest("not json")).toThrow(UpdateRejected)
    expect(() => parseManifest(JSON.stringify({ version: "x", downloads: {} }))).toThrow(UpdateRejected)
  })

  test("manifest download pages are optional and restricted to HTTPS on the store host", () => {
    expect(parseManifest(manifest("1.20.0")).downloadPage).toBeUndefined()
    expect(parseManifest(manifest("1.20.0", { downloadPage: "https://ezkielyna.store/agent/beta" })).downloadPage).toBe(
      "https://ezkielyna.store/agent/beta",
    )
    for (const downloadPage of [
      "http://ezkielyna.store/agent/beta",
      "https://evil.example/agent/beta",
      "https://ezkielyna.store.evil.example/agent/beta",
      "https://user@ezkielyna.store/agent/beta",
      "https://ezkielyna.store:444/agent/beta",
    ]) {
      expect(() => parseManifest(manifest("1.20.0", { downloadPage }))).toThrow(UpdateRejected)
    }
    expect(() => parseManifest(manifest("1.20.0", { downloadPage: 5 }))).toThrow(UpdateRejected)
  })

  test("artifact bytes are checked against the signed hash and size", () => {
    verifyBytes(Buffer.from("exe"), { sha256: sha("exe"), size: 3 })
    expect(() => verifyBytes(Buffer.from("exX"), { sha256: sha("exe"), size: 3 })).toThrow(UpdateRejected)
    expect(() => verifyBytes(Buffer.from("exe"), { sha256: sha("exe"), size: 4 })).toThrow(UpdateRejected)
  })

  test("semver ordering incl. our -ezk.N pre-releases", () => {
    expect(compareVersions("1.19.3", "1.19.3-ezk.1")).toBe(1)
    expect(compareVersions("1.19.3-ezk.2", "1.19.3-ezk.1")).toBe(1)
    expect(compareVersions("1.19.3-ezk.10", "1.19.3-ezk.9")).toBe(1)
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1)
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
    expect(compareVersions("nope", "1.0.0")).toBeUndefined()
    expect(isNewer("1.19.3-ezk.1", "1.19.3-ezk.2")).toBe(true)
    expect(isNewer("1.19.3-ezk.1", "1.19.3-ezk.1")).toBe(false)
  })

  test("signature helper rejects garbage without throwing", () => {
    expect(verifySignature("x", new Uint8Array(), pem)).toBe(false)
    expect(verifySignature("x", signWith("x"), "not a pem")).toBe(false)
  })

  test("CLI platform keys", () => {
    expect(cliPlatformKey("darwin", "arm64")).toBe("darwin-arm64")
    expect(cliPlatformKey("win32", "x64")).toBe("windows-x64")
  })
})
