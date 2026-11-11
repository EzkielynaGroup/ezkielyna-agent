// Shared harness for the CLI first-run e2e tests: spawns the real CLI (from source) in an isolated profile against the
// mock gateway. No real keys: the API key is a fake string the mock accepts.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Step, startMockGateway } from "../../../core/test/ezk/mock-gateway"

export const ROOT = path.resolve(import.meta.dir, "../..")
export const KEY = "sk-" + "test_not-a-real-key"
export const MODEL = "deepseek-v4.1-flash"

export type Profile = ReturnType<typeof profile>

export function profile(cleanups: (() => void)[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-firstrun-"))
  const dirs = Object.fromEntries(["data", "config", "cache", "state", "project"].map((k) => [k, path.join(dir, k)])) as Record<
    "data" | "config" | "cache" | "state" | "project",
    string
  >
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }))
  dirs.project = fs.realpathSync(dirs.project) // macOS tmp is a symlink; the project instance uses the real path
  fs.mkdirSync(path.join(dirs.config, "ezkielyna"), { recursive: true })
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, dirs }
}

export type SpawnOptions = {
  prof: Profile
  script?: Step[]
  /** run in this folder (default: the profile's project folder) */
  cwd?: string
  env?: Record<string, string | undefined>
  stdin?: string
  /** do not set EZKIELYNA_API_KEY (the "no key yet" case) */
  noKey?: boolean
}

/** `ezkielyna <args>` with the mock gateway behind it. `args` are the CLI args (command first). */
export async function ezk(args: string[], cleanups: (() => void)[], opts: SpawnOptions) {
  const gw = startMockGateway({ models: { [KEY]: [MODEL] }, script: { [MODEL]: [...(opts.script ?? [])] }, requireKey: true })
  cleanups.push(() => gw.stop())
  const { prof } = opts
  const env: Record<string, string> = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("OPENCODE_") && !k.startsWith("XDG_") && !k.startsWith("EZK") && k !== "NO_COLOR" && k !== "FORCE_COLOR")) as Record<string, string>),
    HOME: prof.dir,
    XDG_DATA_HOME: prof.dirs.data,
    XDG_CONFIG_HOME: prof.dirs.config,
    XDG_CACHE_HOME: prof.dirs.cache,
    XDG_STATE_HOME: prof.dirs.state,
    EZKIELYNA_BASE_URL: gw.baseURL,
    ...(opts.noKey ? {} : { EZKIELYNA_API_KEY: KEY }),
    EZK_TEST_HIDDEN: "1",
    EZK_NO_KEYCHAIN: "1", // never touch the real OS keychain from a test
    EZK_TRUST_PROJECT: "1", // tests that need an untrusted folder pass EZK_TRUST_PROJECT: "0"
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  const proc = Bun.spawn(["bun", "run", path.join(ROOT, "src/index.ts"), ...args], {
    cwd: opts.cwd ?? prof.dirs.project,
    env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, stdout, stderr, gw, prof }
}

export const bash = (command: string): Step => ({ ok: true, tool: { name: "bash", args: { command, description: "run" } } })
export const say = (text: string, usage?: { prompt: number; completion: number }): Step => ({ ok: true, text, usage })
export const count = (text: string, needle: string) => text.split(needle).length - 1
