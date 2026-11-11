import { cmd } from "./cmd"
import path from "node:path"
import { isProjectTrusted, trustProject, untrustProject } from "@opencode-ai/core/ezkielyna-trust"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { trustFile } from "../../config/trust"
import { UI } from "../ui"

/** Shown in `ezkielyna --help` and `ezkielyna trust --help`. Trust also gates the permission modes (core/src/ezk/safety/modes.ts). */
export const TRUST_DESCRIBE =
  "trust a project folder (its plugins, tools, settings, AGENTS.md and --permission-mode only apply in trusted folders)"

// Ezkielyna Agent: `ezkielyna trust [dir]` marks a project folder as trusted so its plugins, custom tools, agents,
// commands and permission settings are honoured. Untrusted folders only apply harmless preferences.
export const TrustCommand = cmd({
  command: "trust [dir]",
  describe: TRUST_DESCRIBE,
  builder: (yargs) =>
    yargs
      .positional("dir", { type: "string", describe: "project folder (default: current folder)" })
      .option("revoke", { type: "boolean", describe: "remove the folder from the trusted list" })
      .option("status", { type: "boolean", describe: "only print whether the folder is trusted" }),
  handler(args) {
    const lang = detectLang()
    const dir = path.resolve(args.dir ?? process.cwd())
    const file = trustFile()
    if (args.status) {
      const trusted = isProjectTrusted(dir, { file })
      UI.println(trusted ? (lang === "id" ? `${dir}: dipercaya` : `${dir}: trusted`) : lang === "id" ? `${dir}: belum dipercaya` : `${dir}: not trusted`)
      process.exitCode = trusted ? 0 : 1
      return
    }
    if (args.revoke) {
      UI.println(untrustProject(dir, { file }) ? (lang === "id" ? `Kepercayaan dicabut untuk: ${dir}` : `Trust removed: ${dir}`) : lang === "id" ? "Folder ini tidak ada di daftar folder dipercaya." : "This folder was not on the list.")
      return
    }
    const real = trustProject(dir, { file })
    UI.println(lang === "id" ? `Dipercaya: ${real}\nPlugin, alat khusus, agen, perintah, dan pengaturan izin dari folder ini sekarang dipakai.` : `Trusted: ${real}\nPlugins, custom tools, agents, commands and permission settings from this folder are now used.`)
  },
})
