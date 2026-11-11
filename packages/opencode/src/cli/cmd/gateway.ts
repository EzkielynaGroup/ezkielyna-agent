import type { Argv, CommandModule } from "yargs"

async function readToken() {
  if (process.stdin.isTTY) process.stderr.write("Paste the bot token, then Enter: ")
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
    if (String(chunk).includes("\n")) break
  }
  return Buffer.concat(chunks).toString().trim()
}

type GatewayArgs = { action?: string; args?: string[]; pair?: boolean; server?: string }

export const GatewayCommand: CommandModule<{}, GatewayArgs> = {
  command: "gateway telegram <action> [args..]",
  describe: "manage or run the Telegram gateway bridge",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", { type: "string", demandOption: true, describe: "set-token, forget-token, allow, deny, folder, or run" })
      .positional("args", { type: "string", array: true, describe: "arguments for the selected action" })
      .option("pair", { type: "boolean", describe: "show a one-time pairing code" })
      .option("server", { type: "string", describe: "connect to an existing server URL" }),
  handler: async (argv) => {
    const args = argv.args ?? []
    switch (argv.action) {
      case "set-token": {
        const { saveToken } = await import("@opencode-ai/core/ezk/telegram/config")
        console.log(`Token saved (${saveToken(await readToken())}).`)
        return
      }
      case "forget-token": {
        const { deleteToken } = await import("@opencode-ai/core/ezk/telegram/config")
        deleteToken()
        console.log("Token deleted.")
        return
      }
      case "allow":
      case "deny": {
        const id = Number(args[0])
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Usage: allow|deny <numeric telegram user id>")
        const [{ Allowlist }, { loadConfig, saveConfig }] = await Promise.all([
          import("@opencode-ai/core/ezk/telegram/allowlist"),
          import("@opencode-ai/core/ezk/telegram/config"),
        ])
        const cfg = loadConfig()
        const list = new Allowlist(cfg.allowedUserIds)
        argv.action === "allow" ? list.add(id) : list.remove(id)
        saveConfig({ ...cfg, allowedUserIds: list.list() })
        console.log(`Allowlist: ${list.list().length} user(s).`)
        return
      }
      case "folder": {
        const [name, directory] = args
        if (!name || !directory) throw new Error("Usage: folder <name> <directory>")
        const { ensureFolder } = await import("@opencode-ai/core/ezk/telegram/run")
        console.log(`Folder ${name} -> ${ensureFolder(name, directory)}`)
        return
      }
      case "run": {
        const { runBridge } = await import("@opencode-ai/core/ezk/telegram/run")
        const controller = new AbortController()
        for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort())
        await runBridge({
          pair: argv.pair,
          serverUrl: argv.server,
          signal: controller.signal,
          onReady: ({ pairingCode }) => {
            if (pairingCode) console.log(`Pairing code (10 min, single use): ${pairingCode}\nSend "/pair ${pairingCode}" to your bot from your own account.`)
          },
        })
        return
      }
      default:
        throw new Error("Commands: set-token | forget-token | allow <id> | deny <id> | folder <name> <directory> | run [--pair] [--server URL]")
    }
  },
}
