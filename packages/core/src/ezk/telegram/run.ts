// Wires the pieces together and runs the bridge until `signal` aborts. Nothing here runs unless someone calls it.
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { httpAgentClient } from "./agent-client"
import { Allowlist, Pairing } from "./allowlist"
import { Bridge } from "./bridge"
import { loadConfig, loadState, loadToken, memoryDir, profileDir, saveConfig, saveState } from "./config"
import { RateLimiter } from "./ratelimit"
import { makeLogger, makeRedactor } from "./redact"
import { TelegramApi } from "./telegram-api"

export type RunOptions = {
  dir?: string
  serverUrl?: string // connect to an already running `ezkielyna serve`; otherwise spawn one for this run
  serveCmd?: string[]
  pair?: boolean
  apiBase?: string
  signal: AbortSignal
  env?: NodeJS.ProcessEnv
  onReady?: (info: { pairingCode?: string }) => void
}

export async function assertTelegramProfile(
  serverUrl: string,
  username: string,
  password: string,
  expectedMemoryDir: string,
  fetchImpl: typeof fetch = fetch,
) {
  let response: Response
  try {
    response = await fetchImpl(new URL("/ezk/memory", serverUrl), {
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new Error("Could not verify the existing server's Telegram memory profile; omit --server to start an isolated server.")
  }
  if (!response.ok) throw new Error("Could not verify the existing server's Telegram memory profile; omit --server to start an isolated server.")
  const status = (await response.json().catch(() => ({}))) as { profile?: string; dir?: string }
  if (status.profile !== "telegram" || !status.dir || path.resolve(status.dir) !== path.resolve(expectedMemoryDir)) {
    throw new Error("The existing server is not using the isolated Telegram profile. Start it with EZK_PROFILE=telegram and the matching EZK_MEMORY_DIR, or omit --server.")
  }
}

function spawnServer(cmd: string[], env: NodeJS.ProcessEnv, password: string, dir: string, signal: AbortSignal) {
  return new Promise<{ url: string; child: ChildProcess }>((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...env, EZK_SERVER_PASSWORD: password, EZK_PROFILE: "telegram", EZK_MEMORY_DIR: memoryDir(dir) },
    })
    const timer = setTimeout(() => reject(new Error("ezkielyna serve did not start in 30s")), 30_000)
    let buf = ""
    child.stdout!.on("data", (d) => {
      buf += String(d)
      const m = /listening on (http:\/\/\S+)/.exec(buf)
      if (m) {
        clearTimeout(timer)
        resolve({ url: m[1]!, child })
      }
    })
    child.on("error", (e) => reject(e))
    child.on("exit", () => reject(new Error("ezkielyna serve exited early")))
    signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true })
  })
}

export async function runBridge(opts: RunOptions): Promise<void> {
  const env = opts.env ?? process.env
  const dir = opts.dir ?? profileDir(env)
  const token = loadToken(dir, undefined, env)
  if (!token) throw new Error("No bot token. Create a bot with @BotFather, then run: ezkielyna-telegram set-token (token on stdin).")
  const config = loadConfig(dir)
  if (config.allowedUserIds.length === 0 && !opts.pair) throw new Error("The allowlist is empty. Add your Telegram user id (allow <id>) or start with --pair.")
  const redact = makeRedactor(token, env.EZK_SERVER_PASSWORD)
  const log = makeLogger(redact)
  const allowlist = new Allowlist(config.allowedUserIds)
  const pairing = opts.pair ? new Pairing() : undefined
  const code = pairing?.issue()

  const password = env.EZK_SERVER_PASSWORD || randomBytes(18).toString("base64url")
  const username = env.OPENCODE_SERVER_USERNAME || "ezkielyna"
  const telegramMemoryDir = memoryDir(dir)
  let persistedAllowlist = [...config.allowedUserIds]
  let child: ChildProcess | undefined
  let url = opts.serverUrl ?? env.EZK_TELEGRAM_SERVER_URL
  if (!url) {
    const s = await spawnServer(opts.serveCmd ?? ["ezkielyna", "serve", "--port", "0", "--hostname", "127.0.0.1"], env, password, dir, opts.signal)
    url = s.url
    child = s.child
  } else {
    await assertTelegramProfile(url, username, password, telegramMemoryDir)
  }

  const bridge = new Bridge({
    api: new TelegramApi(token, opts.apiBase ?? env.EZK_TELEGRAM_API_BASE),
    agent: httpAgentClient(url, username, password),
    config,
    allowlist,
    pairing,
    limiter: new RateLimiter(config.rateLimit.capacity, config.rateLimit.windowSeconds * 1000),
    state: loadState(dir),
    persist: (state, allowed) => {
      saveState(state, dir)
      const latest = loadConfig(dir)
      const additions = allowed.filter((id) => !persistedAllowlist.includes(id))
      const merged = [...latest.allowedUserIds, ...additions.filter((id) => !latest.allowedUserIds.includes(id))]
      if (merged.join() !== latest.allowedUserIds.join()) saveConfig({ ...latest, allowedUserIds: merged }, dir)
      allowlist.replace(merged)
      Object.assign(config, latest, { allowedUserIds: merged })
      persistedAllowlist = merged
    },
    refreshAllowlist: () => {
      const latest = loadConfig(dir)
      allowlist.replace(latest.allowedUserIds)
      Object.assign(config, latest)
      persistedAllowlist = [...latest.allowedUserIds]
    },
    redactOutput: redact,
    log,
  })
  log(`bridge started (allowlist: ${allowlist.list().length} user(s), folders: ${Object.keys(config.folders).length})`)
  opts.onReady?.({ pairingCode: code })
  try {
    await bridge.poll(opts.signal)
  } finally {
    bridge.stop()
    child?.kill("SIGTERM")
    log("bridge stopped")
  }
}

export function ensureFolder(name: string, folder: string, dir = profileDir()) {
  const abs = fs.realpathSync(path.resolve(folder))
  if (!fs.statSync(abs).isDirectory()) throw new Error("Not a directory")
  const cfg = loadConfig(dir)
  cfg.folders[name] = abs
  cfg.defaultFolder ??= name
  saveConfig(cfg, dir)
  return abs
}
