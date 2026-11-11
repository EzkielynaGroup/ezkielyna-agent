import { createResource, createMemo } from "solid-js"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { type EzkTransport, ezk, routeLabel } from "./api"
import { ut } from "./ux/strings"

const transport = (sdk: ReturnType<typeof useSDK>): EzkTransport => ({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers })

const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`

/** /memory: notes, private toggle for this session, add a note, erase everything. Server owns all logic. */
export function DialogMemory(props: { sessionID?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const api = ezk(transport(sdk))
  const [status, { refetch }] = createResource(() => api.memory(props.sessionID))
  dialog.setSize("large")

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const s = status()
    if (!s) return []
    const out: DialogSelectOption<string>[] = [
      {
        title: s.private ? "Private session: ON (nothing is read, saved or searched)" : "Private session: OFF",
        description: props.sessionID ? "Toggle for this session" : "Open a session first",
        value: "private",
        category: "Controls",
        onSelect: async () => {
          if (!props.sessionID) return
          const ok = await DialogConfirm.show(dialog, ut("memory.private.title"), ut("memory.private.message"), ut(s.private ? "memory.private.enable" : "memory.private.keep"))
          if (ok !== true) {
            dialog.replace(() => <DialogMemory sessionID={props.sessionID} />)
            return
          }
          try {
            await api.setPrivate(props.sessionID, !s.private)
            toast.show({ message: ut(s.private ? "action.memory.private.off" : "action.memory.private.on"), variant: "success" })
            dialog.clear()
          } catch {
            toast.show({ message: ut("action.memory.private.failed"), variant: "error" })
            dialog.replace(() => <DialogMemory sessionID={props.sessionID} />)
          }
        },
      },
      {
        title: "Add a note about you…",
        value: "add",
        category: "Controls",
        onSelect: async () => {
          const text = await DialogPrompt.show(dialog, "Add a note (saved locally, one short sentence)")
          if (text) {
            const r = await api.op({ action: "add", store: "user", text })
            toast.show({ message: ut(r.ok ? "action.memory.added" : "action.memory.add.failed"), variant: r.ok ? "success" : "error" })
          }
          dialog.replace(() => <DialogMemory sessionID={props.sessionID} />)
        },
      },
      {
        title: "Erase all memory and search index…",
        description: "Deletes MEMORY.md, USER.md and the session search index. Sessions stay.",
        value: "wipe",
        category: "Controls",
        onSelect: async () => {
          const ok = await DialogConfirm.show(dialog, ut("memory.erase.title"), ut("memory.erase.message"), ut("memory.erase.button"))
          if (ok === true) {
            try {
              await api.wipe()
              toast.show({ message: ut("action.memory.erased"), variant: "success" })
            } catch {
              toast.show({ message: ut("action.memory.erase.failed"), variant: "error" })
            }
          }
          dialog.clear()
        },
      },
    ]
    for (const [store, label] of [["user", "About you"], ["memory", "Environment"]] as const) {
      for (const text of s[store].entries) {
        out.push({
          title: text,
          description: "Enter to remove",
          value: `${store}:${text}`,
          category: `${label} (${s[store].chars}/${s[store].limit})`,
          onSelect: async () => {
            const ok = await DialogConfirm.show(dialog, ut("memory.remove.title"), text, ut("confirm.delete"))
            if (ok === true) {
              try {
                const result = await api.op({ action: "remove", store, match: text })
                if (!result.ok) throw new Error("remove failed")
                toast.show({ message: ut("action.memory.removed"), variant: "success" })
              } catch {
                toast.show({ message: ut("action.memory.remove.failed"), variant: "error" })
              }
            }
            dialog.replace(() => <DialogMemory sessionID={props.sessionID} />)
          },
        })
      }
    }
    return out
  })

  return (
    <DialogSelect
      title={status() ? `Memory${status()!.enabled ? "" : " (off)"} · local only, never uploaded` : "Memory"}
      placeholder="Filter notes…"
      options={options()}
      onSelect={(o) => o.onSelect?.(dialog)}
    />
  )
}

/** /search: full-text search of past sessions. */
export function DialogSearch(props: { sessionID?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const route = useRoute()
  const toast = useToast()
  const api = ezk(transport(sdk))
  const [query] = createResource(async () => {
    const q = await DialogPrompt.show(dialog, "Search past sessions")
    if (!q) {
      dialog.clear()
      return undefined
    }
    try {
      return { q, ...(await api.search(q, props.sessionID)) }
    } catch (e) {
      toast.show({ message: `Search failed: ${(e as Error).message}`, variant: "error" })
      dialog.clear()
      return undefined
    }
  })
  const options = createMemo<DialogSelectOption<string>[]>(() =>
    (query()?.hits ?? []).map((h) => ({
      title: h.snippet.replace(/\s+/g, " "),
      description: `${h.title ?? h.sessionID} · ${new Date(h.time).toISOString().slice(0, 10)} · ${h.role}`,
      value: h.sessionID,
      category: "Matches",
      onSelect: () => {
        route.navigate({ type: "session", sessionID: h.sessionID })
        dialog.clear()
      },
    })),
  )
  return <DialogSelect title={query() ? `Search: ${query()!.q}` : "Search"} options={options()} skipFilter renderFilter={false} onSelect={(o) => o.onSelect?.(dialog)} />
}

/** /route: how the router decided, health and spend. */
export function DialogRoute(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const api = ezk(transport(sdk))
  const [data] = createResource(async () => ({ status: await api.routerStatus(props.sessionID), turns: await api.turns(props.sessionID) }))
  dialog.setSize("large")
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const d = data()
    if (!d) return []
    const out: DialogSelectOption<string>[] = [
      { title: `Session spend ${usd(d.status.spentUSD)} of ${d.status.capUSD > 0 ? usd(d.status.capUSD) : "no cap"}`, value: "spend", category: "Status" },
      ...d.status.breakers.map((b) => ({
        title: `${b.model} unavailable until ${new Date(b.openUntil).toLocaleTimeString()}`,
        description: b.reason,
        value: `br:${b.model}`,
        category: "Status",
      })),
    ]
    for (const t of d.turns.slice(-15).reverse()) {
      out.push({ title: `${t.route.model} · ${routeLabel(t.route)}`, description: t.route.reason, value: t.messageID, category: "Recent turns" })
    }
    return out
  })
  return <DialogSelect title="Auto router" options={options()} skipFilter renderFilter={false} onSelect={() => dialog.clear()} />
}

export type { DialogContext }
