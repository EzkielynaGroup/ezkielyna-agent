import type { DialogContext } from "../ui/dialog"
import type { useSDK } from "../context/sdk"
import type { useLocal } from "../context/local"
import type { useToast } from "../ui/toast"
import { EZK_AUTO_MODEL_ID } from "@opencode-ai/core/ezk/contracts"
import { ezk } from "./api"
import { DialogMemory, DialogRoute, DialogSearch } from "./dialogs"
import { DialogPermissions } from "./safety"
import { laneApi, laneCommands } from "./lane"
import { createBugReportCommand, fetchBugReport, saveTuiBugReport } from "./bugreport"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"

type EzkCommand = { title: string; value: string; category: string; slash: { name: string; aliases?: undefined }; run: () => void | Promise<void> }

// Slash commands of the ezk features, spread into the session command list (routes/session/index.tsx).
// /auto switches the model picker to Auto (smart); /pin pins the model the router used last; /route, /memory, /search, /private.
export function ezkSessionCommands(deps: {
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  local: ReturnType<typeof useLocal>
  toast: ReturnType<typeof useToast>
  sessionID: string
}): EzkCommand[] {
  const { dialog, sdk, local, toast, sessionID } = deps
  const api = () => ezk({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers })
  const bugReport = createBugReportCommand({
    language: detectLang(),
    request: () => {
      const current = local.model.current()
      const model = current?.providerID && current.modelID ? `${current.providerID}/${current.modelID}` : undefined
      return fetchBugReport({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers, directory: sdk.directory }, model)
    },
    save: (report) => saveTuiBugReport(report, sdk.directory),
    toast,
  })
  return [
    bugReport,
    {
      title: detectLang() === "id" ? "Model otomatis (Pintar)" : "Auto model (smart)",
      value: "ezk.auto",
      category: "Model",
      slash: { name: "auto" },
      run: () => {
        local.model.set({ providerID: "ezkielyna", modelID: EZK_AUTO_MODEL_ID }, { recent: true })
        toast.show({
          message:
            detectLang() === "id"
              ? "Otomatis (Pintar): router memilih model untuk setiap pesan. Pilih model apa saja untuk mengunci."
              : "Auto (smart): the router picks the model per message. Pick any model to pin it.",
          variant: "info",
        })
        dialog.clear()
      },
    },
    {
      title: "Pin the model the router used",
      value: "ezk.pin",
      category: "Model",
      slash: { name: "pin" },
      run: async () => {
        const turns = await api().turns(sessionID).catch(() => [])
        const last = turns.at(-1)?.route.model
        if (!last) toast.show({ message: "Nothing to pin yet: send a message with Auto first.", variant: "warning" })
        else {
          local.model.set({ providerID: "ezkielyna", modelID: last }, { recent: true })
          toast.show({ message: `Pinned to ${last}. /auto turns the router back on.`, variant: "success" })
        }
        dialog.clear()
      },
    },
    {
      title: "Auto router: decisions and health",
      value: "ezk.route",
      category: "Model",
      slash: { name: "route" },
      run: () => dialog.replace(() => <DialogRoute sessionID={sessionID} />),
    },
    {
      title: "Memory: notes, private session, erase",
      value: "ezk.memory",
      category: "Memory",
      slash: { name: "memory" },
      run: () => dialog.replace(() => <DialogMemory sessionID={sessionID} />),
    },
    {
      title: "Toggle private session (memory off)",
      value: "ezk.private",
      category: "Memory",
      slash: { name: "private" },
      run: async () => {
        const cur = await api().memory(sessionID)
        await api().setPrivate(sessionID, !cur.private)
        toast.show({ message: cur.private ? "Memory is on for this session again" : "Private session: memory is off", variant: "info" })
        dialog.clear()
      },
    },
    {
      title: "Search past sessions",
      value: "ezk.search",
      category: "Memory",
      slash: { name: "search" },
      run: () => dialog.replace(() => <DialogSearch sessionID={sessionID} />),
    },
    {
      title: "Permissions: mode, remembered rules, recently denied",
      value: "ezk.permissions",
      category: "Permission",
      slash: { name: "permissions" },
      run: () => dialog.replace(() => <DialogPermissions sessionID={sessionID} />),
    },
    ...laneCommands({ dialog, sessionID, api: laneApi({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers }) }),
  ]
}

/** One-time notice (decision D2: memory is on by default, with a notice). Marks it accepted once shown. */
export async function showMemoryNotice(deps: { sdk: ReturnType<typeof useSDK>; toast: ReturnType<typeof useToast> }) {
  const api = ezk({ fetch: deps.sdk.fetch, url: deps.sdk.url, headers: deps.sdk.headers })
  try {
    const s = await api.memory()
    if (!s.enabled || s.noticeAccepted) return
    deps.toast.show({
      title: "Memory is on",
      message: "Short notes are kept on this computer only and sent to the model as context. /memory to review or erase, /private to turn it off for a session.",
      variant: "info",
      duration: 12000,
    })
    await api.acceptNotice()
  } catch {}
}
