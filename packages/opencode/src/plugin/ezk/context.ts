import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { buildSessionStart } from "@opencode-ai/core/ezk/context/session-start"
import { REPRODUCE_BLOCK, isFixIntent } from "@opencode-ai/core/ezk/context/reproduce"
import { PartID } from "@/session/schema"
import { projectTrusted } from "@/config/trust"
import { ezkRuntime } from "./runtime"

// Ezkielyna Agent v3, context lane. Reminders only: the system prompt and tool list are never touched (cache-stable prefix).
//   A9  (flag ezk.context.session)   first user message of a session carries <session_start_context> (tree, toolchain, verify).
//       The text is built once per session and frozen, so every later step re-sends identical bytes.
//   A10 (flag ezk.context.reproduce) a user message that reads as a bug fix carries <bug_fix_protocol> (<120 tokens).
// Both are appended as synthetic text parts on the in-memory copy of the messages; nothing is persisted.

const MAX_TRACKED = 300
const frozen = new Map<string, string | null>()

const SESSION_MARK = "<session_start_context>"
const REPRODUCE_MARK = "<bug_fix_protocol>"

export async function EzkContextPlugin(input: PluginInput): Promise<Hooks> {
  const rt = ezkRuntime()
  const flags = rt.flags.context
  if (!flags.session && !flags.reproduce) return {}
  const root = input.worktree && input.worktree !== "/" ? input.worktree : input.directory

  const addPart = (message: { info: { id: string; sessionID: string }; parts: any[] }, text: string, mark: string) => {
    if (message.parts.some((p) => p.type === "text" && typeof p.text === "string" && p.text.includes(mark))) return
    message.parts.push({
      id: PartID.ascending(),
      messageID: message.info.id,
      sessionID: message.info.sessionID,
      type: "text",
      text,
      synthetic: true,
    })
  }

  return {
    async "experimental.chat.messages.transform"(_input, out) {
      const users = out.messages.filter((m) => m.info.role === "user")
      const first = users[0]
      if (flags.session && first) {
        const sessionID = first.info.sessionID
        if (!frozen.has(sessionID)) {
          const text = await buildSessionStart(root, { sessionID, trusted: projectTrusted(input.directory, input.worktree) }).catch(() => undefined)
          frozen.set(sessionID, text ?? null)
          if (frozen.size > MAX_TRACKED) frozen.delete(frozen.keys().next().value as string)
        }
        const text = frozen.get(sessionID)
        if (text) addPart(first as any, text, SESSION_MARK)
      }
      // cache: decide per user message from its own text, so earlier fix-intent messages keep their block (prefix-stable)
      if (flags.reproduce) {
        for (const user of users) {
          const prompt = user.parts.map((p: any) => (p.type === "text" && !p.synthetic ? p.text : "")).join(" ")
          if (isFixIntent(prompt)) addPart(user as any, REPRODUCE_BLOCK, REPRODUCE_MARK)
        }
      }
    },
  }
}

/** Test hook. */
export function resetContextPlugin() {
  frozen.clear()
}
