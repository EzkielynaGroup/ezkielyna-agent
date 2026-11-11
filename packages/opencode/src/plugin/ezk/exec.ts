import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import { execManager } from "@opencode-ai/core/ezk/exec/manager"
import { MonitorInbox, type Message } from "@/ezk/exec/monitor"
import { PartID } from "@/session/schema"

// Ezkielyna exec lane (T2): monitor lines as appended reminders, and process-tree kill when a session is deleted.
// Process exit (and SIGTERM/SIGHUP) is covered by the exit hooks the manager installs on first use.
export async function EzkExecPlugin(_input: PluginInput): Promise<Hooks> {
  if (!execEnabled("exec")) return {}
  const manager = execManager()
  const inbox = new MonitorInbox(() => PartID.ascending())
  manager.onMonitor((info, lines) => inbox.lines(info, lines))
  manager.onExit((info) => inbox.exited(info))
  return {
    async "experimental.chat.messages.transform"(_input, output) {
      const delivered = inbox.inject(output.messages as unknown as Message[])
      delivered.forEach((id) => manager.touch(id))
    },
    async event({ event }) {
      const e = event as { type: string; properties?: { info?: { id?: string }; sessionID?: string } }
      if (e.type !== "session.deleted") return
      const id = e.properties?.info?.id ?? e.properties?.sessionID
      if (!id) return
      manager.stopOwner(id)
      inbox.forget(id)
    },
  }
}
