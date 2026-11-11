import { createEffect, createMemo, createResource } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { pendingPlan } from "@opencode-ai/core/ezk/ux/plan"
import type { UxMessage } from "@opencode-ai/core/ezk/ux/types"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { extractPromptFromParts } from "@/utils/prompt"
import { showToast } from "@/utils/toast"
import type { EzkConnection } from "./client"
import { UX_OFF, uxClient } from "./ux-client"
import { DialogEzkHandoff, DialogEzkPlan, DialogEzkRewind } from "./ux-dialogs"
import { uxT } from "./ux-strings"

// Ezkielyna Agent v3 "ux" lane, Desktop wiring used by pages/session.tsx (one hook call + the per-message action):
//   per-message Rewind button and /rewind   -> DialogEzkRewind
//   /handoff                                -> DialogEzkHandoff, then the new session opens with the text prefilled
//   plan agent finished                     -> DialogEzkPlan, once per plan message
// Everything stays hidden while the server reports the flag off.

const shownPlans = new Set<string>()

export function useEzkUxSession(props: { sessionID: () => string | undefined }) {
  const server = useServer()
  const sync = useSync()
  const sdk = useSDK()
  const prompt = usePrompt()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const command = useCommand()
  const t = createMemo(() => uxT(language.locale()))

  const conn = createMemo<EzkConnection | undefined>(() => {
    const c = server.current
    return c ? { url: c.http.url, username: c.http.username, password: c.http.password } : undefined
  })
  const [status] = createResource(conn, (c) => uxClient(c).status(), { initialValue: UX_OFF })
  const idle = () => (sync().data.session_status[props.sessionID() ?? ""]?.type ?? "idle") === "idle"

  const restorePrompt = (messageID: string) => {
    const parts = sync().data.part[messageID] ?? []
    prompt.set(extractPromptFromParts(parts, { directory: sdk().directory, attachmentName: language.t("common.attachment") }))
  }

  const openRewind = (input?: { sessionID: string; messageID: string }) => {
    const c = conn()
    const sessionID = input?.sessionID ?? props.sessionID()
    if (!c || !sessionID) return
    if (!idle()) return void showToast({ title: t()("rewind.busy") })
    dialog.show(() => (
      <DialogEzkRewind
        conn={c}
        sessionID={sessionID}
        lang={language.locale()}
        messageID={input?.messageID}
        onRestorePrompt={restorePrompt}
        onDone={(text, warning) => showToast({ title: t()("rewind.done"), description: text, variant: warning ? "error" : "success" })}
      />
    ))
  }

  const openHandoff = () => {
    const c = conn()
    const sessionID = props.sessionID()
    if (!c || !sessionID) return
    dialog.show(() => (
      <DialogEzkHandoff
        conn={c}
        sessionID={sessionID}
        lang={language.locale()}
        onCreated={(res) => {
          const dir = base64Encode(sdk().directory)
          prompt.set([{ type: "text", content: res.prompt, start: 0, end: res.prompt.length }], res.prompt.length, { dir, id: res.sessionID })
          navigate(`/${dir}/session/${res.sessionID}`)
        }}
      />
    ))
  }

  // the plan approval card, once per finished plan reply
  createEffect(() => {
    const c = conn()
    const sessionID = props.sessionID()
    if (!c || !sessionID || !status().planApproval || !idle()) return
    const last = (sync().data.message[sessionID] ?? []).at(-1)
    if (!last || shownPlans.has(last.id)) return
    const plan = pendingPlan([{ info: last, parts: sync().data.part[last.id] ?? [] } as unknown as UxMessage])
    if (!plan) return
    shownPlans.add(plan.messageID)
    dialog.show(() => (
      <DialogEzkPlan
        conn={c}
        sessionID={sessionID}
        lang={language.locale()}
        plan={plan.text}
        onApproved={(text) => showToast({ title: t()("plan.title"), description: text, variant: "success" })}
      />
    ))
  })

  command.register("ezk-ux", () => [
    ...(status().rewind
      ? [{ id: "ezk.rewind", title: t()("rewind.title"), description: t()("rewind.sub"), category: "Session", slash: "rewind", onSelect: () => openRewind() }]
      : []),
    ...(status().handoff
      ? [{ id: "ezk.handoff", title: t()("handoff.title"), description: t()("handoff.sub"), category: "Session", slash: "handoff", onSelect: openHandoff }]
      : []),
  ])

  return {
    rewindEnabled: () => !!status().rewind,
    rewindLabel: () => t()("rewind.menu"),
    openRewind,
  }
}
