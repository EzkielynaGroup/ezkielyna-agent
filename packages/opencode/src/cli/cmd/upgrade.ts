import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { checkUpgradeTarget } from "@/ezk/upgrade-check"

// Ezkielyna Agent: updates come only from our signed installer (see installation/index.ts).
export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade ezkielyna to the latest signed release",
  builder: (yargs: Argv) => {
    return yargs.positional("target", {
      describe: "version to upgrade to, for ex '1.19.3-ezk.2'",
      type: "string",
    })
  },
  handler: async (args: { target?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const method = await Installation.method()
    const lang = detectLang()
    // A refusal says why and exits non-zero; "Done" is printed only after a real success or when nothing needed doing.
    const refuse = (reason: string) => {
      prompts.log.error(reason)
      process.exitCode = 1
    }
    const latest = await Installation.latest(method).catch(() => undefined)
    if (!args.target && !latest) {
      refuse(lang === "id" ? "Tidak bisa memeriksa pembaruan. Periksa koneksi internet Anda, lalu coba lagi." : "Couldn't check for updates. Check your internet connection and try again.")
      return
    }
    const check = checkUpgradeTarget({ requested: args.target, current: InstallationVersion, latest, hasServer: Boolean(EZK.updateURL), lang })
    if (!check.ok) {
      refuse(check.reason)
      return
    }
    const target = check.target

    if (check.same) {
      prompts.log.warn(`ezkielyna upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      refuse(err instanceof Installation.UpgradeFailedError ? err.stderr : err instanceof Error ? err.message : String(err))
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
