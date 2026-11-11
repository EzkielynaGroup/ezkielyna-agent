#!/usr/bin/env bun
// Standalone entry: `ezkielyna gateway telegram` will call into this (see INTEGRATION-TELEGRAM.md). Never started by default.
//   set-token            read the bot token from stdin (never from argv) and store it in the keychain
//   forget-token         delete the stored token
//   allow <userId>       add a Telegram user id to the allowlist       deny <userId>   remove one
//   folder <name> <dir>  register a workspace folder Telegram users may choose
//   run [--pair] [--server URL]   start the bridge (foreground; Ctrl-C to stop)
import { Allowlist } from "./allowlist"
import { deleteToken, loadConfig, saveConfig, saveToken } from "./config"
import { ensureFolder, runBridge } from "./run"

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Paste the bot token, then Enter (input is not stored in shell history): ")
  const chunks: Buffer[] = []
  for await (const c of process.stdin) {
    chunks.push(c as Buffer)
    if (String(c).includes("\n")) break
  }
  return Buffer.concat(chunks).toString().trim()
}

const [cmd = "run", ...args] = process.argv.slice(2)
const flag = (n: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}

switch (cmd) {
  case "set-token":
    console.log(`Token saved (${saveToken(await readStdin())}).`)
    break
  case "forget-token":
    deleteToken()
    console.log("Token deleted.")
    break
  case "allow":
  case "deny": {
    const id = Number(args[0])
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Usage: allow|deny <numeric telegram user id>")
    const cfg = loadConfig()
    const list = new Allowlist(cfg.allowedUserIds)
    cmd === "allow" ? list.add(id) : list.remove(id)
    saveConfig({ ...cfg, allowedUserIds: list.list() })
    console.log(`Allowlist: ${list.list().length} user(s).`)
    break
  }
  case "folder":
    if (!args[0] || !args[1]) throw new Error("Usage: folder <name> <directory>")
    console.log(`Folder ${args[0]} -> ${ensureFolder(args[0], args[1])}`)
    break
  case "run": {
    const ctl = new AbortController()
    for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => ctl.abort())
    await runBridge({
      pair: args.includes("--pair"),
      serverUrl: flag("--server"),
      signal: ctl.signal,
      onReady: ({ pairingCode }) => {
        if (pairingCode) console.log(`Pairing code (10 min, single use): ${pairingCode}\nSend "/pair ${pairingCode}" to your bot from your own account.`)
      },
    })
    break
  }
  default:
    console.error("Commands: set-token | forget-token | allow <id> | deny <id> | folder <name> <dir> | run [--pair] [--server URL]")
    process.exitCode = 2
}
