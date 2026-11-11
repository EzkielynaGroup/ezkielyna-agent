import { cmd } from "./cmd"
import os from "node:os"
import fs from "node:fs"
import readline from "node:readline"
import { spawn, spawnSync } from "node:child_process"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { createSecretStore } from "@opencode-ai/core/ezkielyna-secrets"
import { describePlan, executePlan, planUninstall, type Deps } from "@/ezk/uninstall"

// Ezkielyna Agent C3: `ezkielyna uninstall [--purge] [--yes]`. The planning and the file operations are in src/ezk/uninstall.ts.
export const UNINSTALL_DESCRIBE = "remove Ezkielyna Agent from this computer (--purge also deletes settings, sign-in, sessions and cache)"

function ask(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(/^(y|yes|ya)$/i.test(answer.trim()))
    })
  })
}

const powershell = (script: string, env: Record<string, string> = {}) =>
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  })

export function windowsDeps(): Pick<Deps, "readUserPath" | "writeUserPath" | "removeAfterExit"> {
  return {
    readUserPath: () => {
      const r = powershell("[Console]::Out.Write([Environment]::GetEnvironmentVariable('Path','User'))")
      if (r.status !== 0) throw new Error(r.stderr.trim() || "could not read the user PATH")
      return r.stdout
    },
    writeUserPath: (value) => {
      const r = powershell("[Environment]::SetEnvironmentVariable('Path', $env:EZK_NEW_PATH, 'User')", { EZK_NEW_PATH: value })
      if (r.status !== 0) throw new Error(r.stderr.trim() || "could not write the user PATH")
    },
    // a running ezkielyna.exe cannot delete its own folder: a detached helper waits a few seconds and does it
    removeAfterExit: (dir) => {
      spawn("cmd.exe", ["/d", "/s", "/c", `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${dir}"`], { detached: true, stdio: "ignore", windowsHide: true }).unref()
    },
  }
}

export const UninstallCommand = cmd({
  command: "uninstall",
  describe: UNINSTALL_DESCRIBE,
  builder: (yargs) =>
    yargs
      .option("purge", { type: "boolean", default: false, describe: "also delete settings, sign-in, sessions, state and cache (~/.config, ~/.local/share, ~/.local/state, ~/.cache under ezkielyna)" })
      .option("yes", { alias: ["y"], type: "boolean", default: false, describe: "do not ask for confirmation" }),
  async handler(args) {
    const lang = detectLang()
    const out = (line: string) => process.stdout.write(line + os.EOL)
    const plan = planUninstall({ platform: process.platform, home: os.homedir(), env: process.env, purge: Boolean(args.purge), lang })
    if (!plan.items.length) {
      out(plan.notes.join(os.EOL) || (lang === "id" ? "Tidak ada yang perlu dihapus." : "Nothing to remove."))
      process.exitCode = plan.notes.length ? 1 : 0
      return
    }
    out(describePlan(plan, lang))
    if (!args.yes) {
      if (!process.stdin.isTTY) {
        process.stderr.write((lang === "id" ? "Tidak bisa bertanya tanpa terminal. Jalankan lagi dengan --yes untuk mengonfirmasi." : "Cannot ask without a terminal. Run again with --yes to confirm.") + os.EOL)
        process.exitCode = 1
        return
      }
      if (!(await ask(lang === "id" ? "Lanjutkan? [y/N] " : "Continue? [y/N] "))) {
        out(lang === "id" ? "Dibatalkan. Tidak ada yang diubah." : "Cancelled. Nothing was changed.")
        process.exitCode = 1
        return
      }
    }
    const deps: Deps = {
      log: out,
      deleteSecret: () => createSecretStore().delete("api-key"),
      ...(process.platform === "win32" ? windowsDeps() : {}),
    }
    const failures = executePlan(plan, deps, lang)
    if (failures) {
      process.exitCode = 1
      return
    }
    out(lang === "id" ? "Selesai. Buka terminal baru agar perintah ezkielyna hilang dari PATH." : "Done. Open a new terminal so the ezkielyna command leaves your PATH.")
  },
})
