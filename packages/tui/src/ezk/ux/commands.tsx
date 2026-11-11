// Ezkielyna Agent v3 "ux" lane, TUI wiring used by routes/session/index.tsx (one hook call + one spread):
//   /rewind and Esc-Esc (idle session)   -> DialogRewind
//   /handoff                             -> runHandoff
//   plan agent finished                  -> DialogPlanApproval, once per plan message
// Everything stays hidden while the server reports the flag off.
import { createEffect, createMemo, createResource } from "solid-js"
import { pendingPlan } from "@opencode-ai/core/ezk/ux/plan"
import type { UxMessage } from "@opencode-ai/core/ezk/ux/types"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useRoute } from "../../context/route"
import { useToast } from "../../ui/toast"
import { OPENCODE_BASE_MODE, useBindings } from "../../keymap"
import { uxStatus } from "./api"
import { DialogPlanApproval, DialogRewind, runHandoff } from "./dialogs"
import { ut } from "./strings"

/** Two presses within `windowMs` fire `onDouble`; the first one fires `onFirst` (the hint). */
export function doublePress(input: { windowMs: number; onFirst: () => void; onDouble: () => void; now?: () => number }) {
  let last: number | undefined
  const now = input.now ?? Date.now
  return () => {
    const t = now()
    if (last !== undefined && t - last <= input.windowMs) {
      last = undefined
      input.onDouble()
      return
    }
    last = t
    input.onFirst()
  }
}

const shownPlans = new Set<string>()

type UxCommand = { title: string; value: string; category: string; slash: { name: string; aliases?: undefined }; run: () => void }

export function useEzkUx(props: {
  sessionID: () => string
  /** put the text of a rewound user message back into the prompt box */
  restorePrompt: (messageID: string) => void
  focusPrompt: () => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const route = useRoute()
  const [status] = createResource(() => uxStatus({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers }))
  const idle = createMemo(() => (sync.data.session_status?.[props.sessionID()]?.type ?? "idle") === "idle")

  const openRewind = () => {
    if (!idle()) return toast.show({ message: ut("rewind.busy"), variant: "warning" })
    dialog.replace(() => <DialogRewind sessionID={props.sessionID()} restorePrompt={props.restorePrompt} />)
  }

  const esc = doublePress({
    windowMs: 1500,
    onFirst: () => toast.show({ message: ut("rewind.hint"), variant: "info", duration: 1500 }),
    onDouble: openRewind,
  })
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: !!status()?.rewind && idle() && dialog.stack.length === 0,
    bindings: [{ key: "escape", desc: ut("rewind.title"), group: "Session", cmd: esc }],
  }))

  // the plan approval card, once per finished plan reply
  createEffect(() => {
    if (!status()?.planApproval || !idle() || dialog.stack.length > 0) return
    const sessionID = props.sessionID()
    const infos = sync.data.message[sessionID] ?? []
    const last = infos.at(-1)
    if (!last || shownPlans.has(last.id)) return
    const plan = pendingPlan([{ info: last, parts: sync.data.part[last.id] ?? [] } as unknown as UxMessage])
    if (!plan) return
    shownPlans.add(plan.messageID)
    dialog.replace(() => <DialogPlanApproval sessionID={sessionID} plan={plan.text} onKeepPlanning={props.focusPrompt} />)
  })

  const commands = createMemo((): UxCommand[] => {
    const s = status()
    return [
      ...(s?.rewind
        ? [
            {
              title: ut("rewind.title"),
              value: "ezk.rewind",
              category: "Session",
              slash: { name: "rewind" },
              run: openRewind,
            },
          ]
        : []),
      ...(s?.handoff
        ? [
            {
              title: ut("handoff.title"),
              value: "ezk.handoff",
              category: "Session",
              slash: { name: "handoff" },
              run: () => void runHandoff({ sdk, dialog, toast, route, sessionID: props.sessionID() }),
            },
          ]
        : []),
    ]
  })

  return { commands, status }
}
