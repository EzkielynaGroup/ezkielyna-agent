// Ezkielyna Agent: API key storage in the operating system's secret store, with a 0600-file fallback handled by the caller.
//
//   macOS    Keychain via /usr/bin/security (the secret goes through `security -i` on stdin, never on argv)
//   Linux    libsecret via `secret-tool` (secret on stdin); needs a session D-Bus + keyring, otherwise unavailable
//   Windows  DPAPI (CurrentUser scope) through PowerShell, secret on stdin, ciphertext in %LOCALAPPDATA%\Ezkielyna
//            (Windows Credential Manager has no argv-free CLI; DPAPI gives the same per-user encryption at rest)
//
// `set` returns false when no backend works; the caller then keeps the key in auth.json (mode 0600) as before.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const SECRET_SERVICE = "Ezkielyna Agent"
/** Stored in auth.json in place of the key when the real key lives in the secret store. */
export const SECRET_SENTINEL = "ezk-keychain:v1"

export type RunResult = { status: number | null; stdout: string; stderr: string }
export type Run = (cmd: string, args: string[], input?: string) => RunResult

export const defaultRun: Run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 8000, windowsHide: true })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

export interface SecretStore {
  readonly backend: "keychain" | "libsecret" | "dpapi" | "none"
  get(account: string): string | undefined
  set(account: string, secret: string): boolean
  delete(account: string): void
}

// Only plain token characters go to a backend: anything else (spaces, quotes, newlines) would need quoting rules per
// tool, so such a value simply stays in the file fallback.
const SAFE = /^[A-Za-z0-9._~+/=:-]{8,512}$/
const ACCOUNT = /^[A-Za-z0-9._-]{1,64}$/

function macos(run: Run): SecretStore {
  return {
    backend: "keychain",
    get(account) {
      if (!ACCOUNT.test(account)) return
      const r = run("security", ["find-generic-password", "-a", account, "-s", SECRET_SERVICE, "-w"])
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined
    },
    set(account, secret) {
      if (!ACCOUNT.test(account) || !SAFE.test(secret)) return false
      const r = run("security", ["-i"], `add-generic-password -U -a ${account} -s "${SECRET_SERVICE}" -w ${secret}\n`)
      return r.status === 0 && !/error|failed/i.test(r.stderr)
    },
    delete(account) {
      if (ACCOUNT.test(account)) run("security", ["delete-generic-password", "-a", account, "-s", SECRET_SERVICE])
    },
  }
}

function linux(run: Run): SecretStore {
  const attrs = (account: string) => ["service", SECRET_SERVICE, "account", account]
  return {
    backend: "libsecret",
    get(account) {
      if (!ACCOUNT.test(account)) return
      const r = run("secret-tool", ["lookup", ...attrs(account)])
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined
    },
    set(account, secret) {
      if (!ACCOUNT.test(account) || !SAFE.test(secret)) return false
      return run("secret-tool", ["store", "--label", SECRET_SERVICE, ...attrs(account)], secret).status === 0
    },
    delete(account) {
      if (ACCOUNT.test(account)) run("secret-tool", ["clear", ...attrs(account)])
    },
  }
}

function windows(run: Run, dir: string, paths: typeof path, makeDirectory: (dir: string) => void): SecretStore {
  const file = (account: string) => paths.join(dir, `secret-${account}.dpapi`)
  const ps = (script: string, input?: string) =>
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], input)
  return {
    backend: "dpapi",
    get(account) {
      if (!ACCOUNT.test(account) || !fs.existsSync(file(account))) return
      const r = ps(
        `Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes('${file(account).replace(/'/g, "''")}'); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`,
      )
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined
    },
    set(account, secret) {
      if (!ACCOUNT.test(account) || !SAFE.test(secret)) return false
      makeDirectory(dir)
      const r = ps(
        `Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); $e=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,'CurrentUser'); [IO.File]::WriteAllBytes('${file(account).replace(/'/g, "''")}',$e)`,
        secret,
      )
      return r.status === 0
    },
    delete(account) {
      if (ACCOUNT.test(account)) fs.rmSync(file(account), { force: true })
    },
  }
}

const none: SecretStore = { backend: "none", get: () => undefined, set: () => false, delete: () => {} }

export function createSecretStore(
  input: {
    platform?: NodeJS.Platform
    run?: Run
    dir?: string
    disabled?: boolean
    pathApi?: typeof path
    env?: Pick<NodeJS.ProcessEnv, "LOCALAPPDATA">
    home?: string
    makeDirectory?: (dir: string) => void
  } = {},
): SecretStore {
  if (input.disabled ?? process.env.EZK_NO_KEYCHAIN === "1") return none
  const run = input.run ?? defaultRun
  switch (input.platform ?? process.platform) {
    case "darwin":
      return macos(run)
    case "linux":
      return linux(run)
    case "win32": {
      const paths = input.pathApi ?? path
      const env = input.env ?? process.env
      const home = input.home ?? os.homedir()
      const dir = input.dir ?? paths.join(env.LOCALAPPDATA ?? paths.join(home, "AppData", "Local"), "Ezkielyna")
      return windows(run, dir, paths, input.makeDirectory ?? ((directory) => fs.mkdirSync(directory, { recursive: true })))
    }
    default:
      return none
  }
}
