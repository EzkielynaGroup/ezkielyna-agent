// Telegram profile: config, token, session map. Separate directory from the desktop profile (and from its memory).
//   <config>/ezkielyna/telegram/config.json   allowlist, folders, limits (0600, never contains the token when a keychain exists)
//   <config>/ezkielyna/telegram/state.json    chat -> session map
//   <config>/ezkielyna/telegram/memory/       memory dir for Telegram sessions (passed to the server as EZK_MEMORY_DIR)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSecretStore, type SecretStore } from "../../ezkielyna-secrets"

export const TOKEN_ACCOUNT = "telegram-bot-token"
const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{20,}$/

export type TelegramConfig = {
  allowedUserIds: number[]
  /** name -> absolute folder. Telegram users can only pick among these, never type a path. */
  folders: Record<string, string>
  defaultFolder?: string
  rateLimit: { capacity: number; windowSeconds: number }
  maxReplyChars: number
  permissionTimeoutSeconds: number
  model?: string
}

export const DEFAULT_CONFIG: TelegramConfig = {
  allowedUserIds: [],
  folders: {},
  rateLimit: { capacity: 10, windowSeconds: 60 },
  maxReplyChars: 3500,
  permissionTimeoutSeconds: 300,
}

export function profileDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EZK_TELEGRAM_DIR) return env.EZK_TELEGRAM_DIR
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "ezkielyna", "telegram")
}

function writePrivate(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function loadConfig(dir = profileDir()): TelegramConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))
    return { ...DEFAULT_CONFIG, ...raw, rateLimit: { ...DEFAULT_CONFIG.rateLimit, ...raw.rateLimit } }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(cfg: TelegramConfig, dir = profileDir()) {
  writePrivate(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n")
}

export function validToken(t: string): boolean {
  return TOKEN_RE.test(t)
}

/** Token lookup order: env EZK_TELEGRAM_BOT_TOKEN, OS keychain, 0600 file fallback. */
export function loadToken(dir = profileDir(), store: SecretStore = createSecretStore(), env = process.env): string | undefined {
  const fromEnv = env.EZK_TELEGRAM_BOT_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const fromStore = store.get(TOKEN_ACCOUNT)
  if (fromStore) return fromStore
  try {
    return fs.readFileSync(path.join(dir, "token"), "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

/** Stores the token in the keychain; only if none is available does it fall back to a 0600 file. Returns where it went. */
export function saveToken(token: string, dir = profileDir(), store: SecretStore = createSecretStore()): "keychain" | "file" {
  if (!validToken(token)) throw new Error("That does not look like a Telegram bot token (expected 123456:ABC...)")
  if (store.set(TOKEN_ACCOUNT, token)) {
    fs.rmSync(path.join(dir, "token"), { force: true })
    return "keychain"
  }
  writePrivate(path.join(dir, "token"), token + "\n")
  return "file"
}

export function deleteToken(dir = profileDir(), store: SecretStore = createSecretStore()) {
  store.delete(TOKEN_ACCOUNT)
  fs.rmSync(path.join(dir, "token"), { force: true })
}

export type ChatState = { sessionID?: string; folder?: string; model?: string }
export type State = Record<string, ChatState>

export function loadState(dir = profileDir()): State {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))
  } catch {
    return {}
  }
}

export function saveState(state: State, dir = profileDir()) {
  writePrivate(path.join(dir, "state.json"), JSON.stringify(state))
}

export function memoryDir(dir = profileDir()): string {
  const m = path.join(dir, "memory")
  fs.mkdirSync(m, { recursive: true, mode: 0o700 })
  return m
}
