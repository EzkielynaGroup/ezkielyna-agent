import type { Argv } from "yargs"
import { Global } from "@opencode-ai/core/global"
import { MemoryStore, LIMITS } from "@opencode-ai/core/ezk/memory/store"
import { ezkPaths, wipeMemory } from "@opencode-ai/core/ezk/wipe"
import { UI } from "../ui"
import { cmd } from "./cmd"

// `ezkielyna memory status|show|wipe`. Pure local file operations; never starts a server and never touches the network.
export const MemoryCommand = cmd<{}, { action: string; yes: boolean; all: boolean }>({
  command: "memory <action>",
  describe: "inspect or erase the local memory (MEMORY.md, USER.md, search index)",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", { choices: ["status", "show", "wipe"] as const, describe: "status | show | wipe", type: "string" })
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "do not ask for confirmation (wipe)" })
      .option("all", { type: "boolean", default: false, describe: "wipe also the router's local data (route records, decision log)" }) as any,
  handler: async (args) => {
    const dirs = { config: Global.Path.config, data: Global.Path.data }
    const paths = ezkPaths(dirs)
    const store = new MemoryStore(paths.memoryDir)
    if (args.action === "status") {
      UI.println(`memory dir: ${store.dir}`)
      UI.println(`MEMORY.md: ${store.chars("memory")}/${LIMITS.memory} chars, ${store.load("memory").length} entries`)
      UI.println(`USER.md:   ${store.chars("user")}/${LIMITS.user} chars, ${store.load("user").length} entries`)
      return
    }
    if (args.action === "show") {
      for (const kind of ["user", "memory"] as const) {
        UI.println(`# ${kind === "user" ? "USER" : "MEMORY"}`)
        for (const e of store.load(kind)) UI.println(`- ${e}`)
      }
      return
    }
    if (!args.yes) {
      const prompts = await import("@clack/prompts")
      const ok = await prompts.confirm({ message: "Erase all memory and the search index? This cannot be undone." })
      if (prompts.isCancel(ok) || !ok) {
        UI.println("Cancelled.")
        return
      }
    }
    const report = wipeMemory(dirs, { includeRouter: args.all })
    UI.println(`Erased: ${report.memoryFiles} memory file(s), search index ${report.searchIndex ? "removed" : "none"}${args.all ? `, router data ${report.routerData ? "removed" : "none"}` : ""}.`)
  },
})
