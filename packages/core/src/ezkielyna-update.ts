// Ezkielyna Agent: integrity-protected update checks.
//
// The apps are not code-signed (no Apple/Microsoft certificates), so every update is authenticated by us instead:
//   - release manifests (`latest.json`, `SHA256SUMS`) are signed OFFLINE with an ECDSA P-256 key (SHA-256) that never
//     leaves the maintainer's offline machine. The signature is the raw DER output of
//     `openssl dgst -sha256 -sign`, stored next to the file as `<name>.sig`.
//   - the matching public key is embedded below and in install.sh / install.ps1. Updates whose signature is missing,
//     malformed or wrong are refused; so are non-HTTPS URLs, other hosts, and versions that are not strictly newer.
//   - artifact bytes are then checked against the sha256/sha512 listed in the verified manifest.
// (P-256 rather than ed25519 because the stock macOS `openssl` (LibreSSL 3.3) cannot verify ed25519, and the installers
// must work with system tools only.)
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto"

export const UPDATE_KEY_ID = "6f357cf04af3cb4d" // first 16 hex chars of sha256(SPKI DER)
export const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6pZu7S24ONm8sScK1XgKDsklqr0F
t1So/uGHhPABBqbyLQjo5Tr7nJ0wI26IS+pbZowhgmkSJw/tHxifomD9yw==
-----END PUBLIC KEY-----
`
export const UPDATE_ALLOWED_HOSTS = ["ezkielyna.store"] as const

export type ArtifactInfo = { file: string; sha256: string; sha512?: string; size: number }
export type Manifest = {
  version: string
  released?: string
  notes?: string
  downloadPage?: string
  downloads: {
    desktop: Record<string, Record<string, ArtifactInfo>>
    cli: Record<string, ArtifactInfo>
  }
}

export class UpdateRejected extends Error {
  constructor(
    public readonly reason: "insecure_url" | "bad_host" | "fetch_failed" | "bad_signature" | "bad_manifest" | "not_newer" | "bad_hash" | "bad_file",
    message: string,
  ) {
    super(message)
    this.name = "UpdateRejected"
  }
}

export function verifySignature(data: Uint8Array | string, signatureDer: Uint8Array, pem: string = UPDATE_PUBLIC_KEY_PEM) {
  try {
    return cryptoVerify("sha256", Buffer.from(data), { key: createPublicKey(pem), dsaEncoding: "der" }, Buffer.from(signatureDer))
  } catch {
    return false
  }
}

export function keyId(pem: string = UPDATE_PUBLIC_KEY_PEM) {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" })
  return createHash("sha256").update(der).digest("hex").slice(0, 16)
}

// --- semver (just enough: x.y.z[-pre.release]) ---------------------------------------------------------------------

function parse(version: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!m) return
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split(".") }
}

/** 1 if a > b, -1 if a < b, 0 if equal, undefined if either is not a valid version. */
export function compareVersions(a: string, b: string): 1 | -1 | 0 | undefined {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1
  if (!x.pre && !y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i]
    const r = y.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    if (ln && rn) {
      if (Number(l) !== Number(r)) return Number(l) > Number(r) ? 1 : -1
    } else if (ln !== rn) return ln ? -1 : 1
    else if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

/** Strictly newer only: equal and older versions (downgrades) are never offered. */
export const isNewer = (current: string, candidate: string) => compareVersions(candidate, current) === 1

// --- manifest ------------------------------------------------------------------------------------------------------

const SAFE_FILE = /^[A-Za-z0-9._+-]+$/
const HEX64 = /^[0-9a-f]{64}$/

function artifact(value: unknown, where: string): ArtifactInfo {
  const v = value as Partial<ArtifactInfo> | undefined
  if (!v || typeof v.file !== "string" || !SAFE_FILE.test(v.file) || v.file.includes("..")) throw new UpdateRejected("bad_manifest", `bad file name in ${where}`)
  if (typeof v.sha256 !== "string" || !HEX64.test(v.sha256)) throw new UpdateRejected("bad_manifest", `bad sha256 in ${where}`)
  if (typeof v.size !== "number" || !Number.isFinite(v.size) || v.size <= 0) throw new UpdateRejected("bad_manifest", `bad size in ${where}`)
  if (v.sha512 !== undefined && (typeof v.sha512 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.sha512))) throw new UpdateRejected("bad_manifest", `bad sha512 in ${where}`)
  return { file: v.file, sha256: v.sha256, sha512: v.sha512, size: v.size }
}

/** Strict shape check. File names are bare names (no paths); URLs are always derived from the signed base, never taken from the manifest. */
export function parseManifest(text: string): Manifest {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    throw new UpdateRejected("bad_manifest", "manifest is not JSON")
  }
  if (!raw || typeof raw.version !== "string" || compareVersions(raw.version, raw.version) !== 0) throw new UpdateRejected("bad_manifest", "bad version")
  const desktop: Manifest["downloads"]["desktop"] = {}
  for (const [platform, kinds] of Object.entries<any>(raw.downloads?.desktop ?? {})) {
    desktop[platform] = {}
    for (const [kind, info] of Object.entries<any>(kinds ?? {})) desktop[platform][kind] = artifact(info, `desktop.${platform}.${kind}`)
  }
  const cli: Manifest["downloads"]["cli"] = {}
  for (const [platform, info] of Object.entries<any>(raw.downloads?.cli ?? {})) cli[platform] = artifact(info, `cli.${platform}`)
  let downloadPage: string | undefined
  if (raw.downloadPage !== undefined) {
    if (typeof raw.downloadPage !== "string") throw new UpdateRejected("bad_manifest", "downloadPage must be a URL")
    let page: URL
    try {
      page = new URL(raw.downloadPage)
    } catch {
      throw new UpdateRejected("bad_manifest", "downloadPage must be a URL")
    }
    if (page.protocol !== "https:" || page.hostname !== "ezkielyna.store" || page.username || page.password || (page.port && page.port !== "443")) {
      throw new UpdateRejected("bad_manifest", "downloadPage must use HTTPS on ezkielyna.store")
    }
    downloadPage = page.href
  }
  return {
    version: raw.version,
    released: typeof raw.released === "string" ? raw.released : undefined,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    downloadPage,
    downloads: { desktop, cli },
  }
}

export function assertSecureBase(base: string, hosts: readonly string[] = UPDATE_ALLOWED_HOSTS) {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new UpdateRejected("insecure_url", "update URL is not a URL")
  }
  if (url.protocol !== "https:") throw new UpdateRejected("insecure_url", "update URL must be https")
  if (!hosts.includes(url.hostname)) throw new UpdateRejected("bad_host", `update host ${url.hostname} is not allowed`)
  return url.href.replace(/\/+$/, "")
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; redirect?: "error" | "follow" | "manual" }) => Promise<{
  ok: boolean
  status: number
  url?: string
  arrayBuffer(): Promise<ArrayBuffer>
}>

async function get(f: FetchLike, url: string, signal?: AbortSignal) {
  let res
  try {
    res = await f(url, { signal, redirect: "error" })
  } catch (cause) {
    throw new UpdateRejected("fetch_failed", `could not fetch ${url}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!res.ok) throw new UpdateRejected("fetch_failed", `${url} answered ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Fetch `latest.json` + `latest.json.sig` from the HTTPS base, verify the signature, and refuse anything that is not a
 * strictly newer version than `currentVersion`. Throws UpdateRejected with a reason; resolves only for a good update.
 */
export async function fetchVerifiedManifest(input: {
  base: string
  currentVersion: string
  fetch?: FetchLike
  pem?: string
  hosts?: readonly string[]
  signal?: AbortSignal
}): Promise<{ manifest: Manifest; base: string }> {
  const base = assertSecureBase(input.base, input.hosts)
  const f = input.fetch ?? (fetch as unknown as FetchLike)
  const [body, sig] = await Promise.all([get(f, `${base}/latest.json`, input.signal), get(f, `${base}/latest.json.sig`, input.signal)])
  if (!verifySignature(body, sig, input.pem)) throw new UpdateRejected("bad_signature", "latest.json signature does not verify")
  const manifest = parseManifest(new TextDecoder().decode(body))
  if (!isNewer(input.currentVersion, manifest.version)) throw new UpdateRejected("not_newer", `${manifest.version} is not newer than ${input.currentVersion}`)
  return { manifest, base }
}

export function verifyBytes(bytes: Uint8Array, expected: { sha256: string; size?: number }) {
  if (expected.size !== undefined && bytes.byteLength !== expected.size) throw new UpdateRejected("bad_hash", "size mismatch")
  const got = createHash("sha256").update(bytes).digest("hex")
  if (got !== expected.sha256) throw new UpdateRejected("bad_hash", "sha256 mismatch")
}

/** `darwin-arm64`, `linux-x64`, `windows-x64` (CLI keys) for the running process. */
export function cliPlatformKey(platform: string = process.platform, arch: string = process.arch) {
  const os = platform === "win32" ? "windows" : platform
  return `${os}-${arch === "x64" || arch === "arm64" ? arch : "x64"}`
}
