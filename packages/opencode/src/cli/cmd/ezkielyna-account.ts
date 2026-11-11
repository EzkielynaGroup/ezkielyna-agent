import { cmd } from "./cmd"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { accountDetails, loadAccountStatus } from "@opencode-ai/core/ezkielyna-account"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { readLocalKey } from "@opencode-ai/core/ezkielyna-localkey"
import { UI } from "../ui"

// Ezkielyna Agent: `ezkielyna account` shows the plan and today's remaining quota, or the balance, from the store /me
// endpoint (gateway billing as fallback). Only the user's own key is sent, and only to our two hosts.
export const AccountCommand = cmd({
  command: "account",
  describe: "show your Ezkielyna plan, remaining quota or balance",
  builder: (yargs) => yargs.option("json", { type: "boolean", describe: "print machine-readable JSON" }),
  async handler(args) {
    const lang = detectLang()
    const key = readLocalKey()
    if (!key) {
      UI.error(lang === "id" ? `Belum masuk. Jalankan: ${EZK.command} providers login` : `Not signed in. Run: ${EZK.command} providers login`)
      process.exitCode = 1
      return
    }
    const status = await loadAccountStatus(key)
    if (!status) {
      UI.error(lang === "id" ? "Tidak bisa mengambil info akun (jaringan atau kunci tidak valid)." : "Could not fetch account info (network down or invalid key).")
      process.exitCode = 1
      return
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(status, null, 2) + "\n")
      return
    }
    for (const line of accountDetails(status, lang)) UI.println(line)
  },
})
