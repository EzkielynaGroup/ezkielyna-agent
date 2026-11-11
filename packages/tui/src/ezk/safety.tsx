// Ezkielyna Agent Wave B: TUI side of permission modes, remembered rules and hooks. The server owns every decision;
// this file only shows the state from /ezk/permission and /ezk/hooks and sends the user's choices back.
import { createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { nextMode, type Mode } from "@opencode-ai/core/ezk/safety/modes"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import type { EzkTransport } from "./api"

type Text = { en: string; id: string }

export interface PermissionStatus {
  flags: { modes: boolean; rules: boolean; hooks: boolean; trustUI: boolean }
  root: string
  mode: { requested: Mode; effective: Mode; trusted: boolean }
  modes: { id: Mode; label: Text; hint: Text }[]
  notice?: Text
  rules: { action: "allow" | "ask" | "deny"; rule: string; source: string; local: boolean }[]
  denied: { at: number; sessionID: string; permission: string; pattern: string; why: string; rule?: string }[]
}

export interface HooksStatus {
  enabled: boolean
  trusted: boolean
  hooks: { event: string; matcher: string; type: string; what: string; source: string; scope: string }[]
  skippedProjectHooks: number
  fingerprint: string
  noticeNeeded: boolean
}

export const lang = () => detectLang()
export const say = (t: Text | undefined) => (t ? t[lang()] : "")
const words = {
  alwaysProject: { en: "Always allow in this project", id: "Selalu izinkan di proyek ini" },
  saved: { en: "Saved for this project", id: "Disimpan untuk proyek ini" },
  risky: { en: "not saved (too risky to always allow)", id: "tidak disimpan (terlalu berisiko untuk selalu diizinkan)" },
  mode: { en: "Mode", id: "Mode" },
  rules: { en: "Remembered rules", id: "Aturan yang diingat" },
  denied: { en: "Recently denied", id: "Baru saja ditolak" },
  none: { en: "Nothing yet", id: "Belum ada" },
  remove: { en: "Enter to remove", id: "Enter untuk menghapus" },
  removeRule: { en: "Remove rule", id: "Hapus aturan" },
  untrusted: { en: "folder not trusted: asks first", id: "folder belum dipercaya: tanya dulu" },
  hooksTitle: { en: "Hooks are active", id: "Hooks aktif" },
  hooksBody: { en: "These programs run automatically on agent events:", id: "Program ini berjalan otomatis saat asisten bekerja:" },
  hooksSkipped: { en: "project hooks ignored: folder not trusted", id: "hooks proyek diabaikan: folder belum dipercaya" },
  fullTitle: { en: "Enable full access mode?", id: "Aktifkan mode akses penuh?" },
  fullMessage: { en: "The agent can run actions with fewer permission checks in this folder.", id: "Agen dapat menjalankan tindakan dengan lebih sedikit pemeriksaan izin di folder ini." },
  fullConfirm: { en: "Enable full access", id: "Aktifkan akses penuh" },
  modeUpdated: { en: "Permission mode updated", id: "Mode izin diperbarui" },
  modeFailed: { en: "Could not update permission mode", id: "Mode izin tidak dapat diperbarui" },
  ruleRemoved: { en: "Permission rule removed", id: "Aturan izin dihapus" },
  ruleRemoveFailed: { en: "Could not remove permission rule", id: "Aturan izin tidak dapat dihapus" },
}
export const t = (key: keyof typeof words) => words[key][lang()]

const call = async <T,>(tr: EzkTransport, method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
  const headers = new Headers(tr.headers)
  if (body !== undefined) headers.set("content-type", "application/json")
  const res = await tr.fetch(`${tr.url.replace(/\/+$/, "")}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`)
  return json
}

export const safetyApi = (tr: EzkTransport & { directory?: string }) => {
  const dir = encodeURIComponent(tr.directory ?? process.cwd())
  return {
    status: (sessionID?: string) => call<PermissionStatus>(tr, "GET", `/ezk/permission?directory=${dir}${sessionID ? `&sessionID=${encodeURIComponent(sessionID)}` : ""}`),
    setMode: (mode: Mode, sessionID?: string) => call<PermissionStatus>(tr, "POST", "/ezk/permission/mode", { directory: tr.directory ?? process.cwd(), sessionID, mode }),
    remember: (permission: string, patterns: string[]) => call<{ saved: string[]; skipped: string[] }>(tr, "POST", "/ezk/permission/remember", { directory: tr.directory ?? process.cwd(), permission, patterns }),
    forget: (rule: string) => call<{ removed: boolean }>(tr, "POST", "/ezk/permission/forget", { directory: tr.directory ?? process.cwd(), rule }),
    hooks: () => call<HooksStatus>(tr, "GET", `/ezk/hooks?directory=${dir}`),
    ackHooks: (fingerprint: string) => call<{ ok: boolean }>(tr, "POST", "/ezk/hooks/ack", { directory: tr.directory ?? process.cwd(), fingerprint }),
  }
}

export const transportOf = (sdk: ReturnType<typeof useSDK>) => ({ fetch: sdk.fetch, url: sdk.url, headers: sdk.headers, directory: sdk.directory })

// --- shared mode state (footer label, Shift+Tab) --------------------------------------------------------------------

const [store, setStore] = createStore<{ status?: PermissionStatus; sessionID?: string }>({})
export const permissionState = store

export async function refreshPermission(tr: ReturnType<typeof transportOf>, sessionID?: string) {
  const status = await safetyApi(tr).status(sessionID).catch(() => undefined)
  if (status) setStore({ status, sessionID })
  return status
}

/** Shift+Tab: next mode for this session (or for new sessions on the home screen). false = modes are off. */
export async function cycleMode(tr: ReturnType<typeof transportOf>, sessionID: string | undefined, reverse = false) {
  const current = store.status && store.sessionID === sessionID ? store.status : await refreshPermission(tr, sessionID)
  if (!current?.flags.modes) return false
  const status = await safetyApi(tr).setMode(nextMode(current.mode.requested, reverse), sessionID).catch(() => undefined)
  if (status) setStore({ status, sessionID })
  return status ?? false
}

export function modeLabel(status: PermissionStatus | undefined) {
  if (!status?.flags.modes) return
  const entry = status.modes.find((m) => m.id === status.mode.effective)
  const label = say(entry?.label)
  return status.mode.requested !== status.mode.effective ? `${label} (${t("untrusted")})` : label
}

// --- /permissions -----------------------------------------------------------------------------------------------

export function DialogPermissions(props: { sessionID?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const api = safetyApi(transportOf(sdk))
  const [status] = createResource(() => api.status(props.sessionID))
  dialog.setSize("large")

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const s = status()
    if (!s) return []
    const out: DialogSelectOption<string>[] = []
    if (s.flags.modes)
      for (const m of s.modes)
        out.push({
          title: `${m.id === s.mode.requested ? "● " : "  "}${say(m.label)}`,
          description: say(m.hint),
          value: `mode:${m.id}`,
          category: `${t("mode")}${s.mode.trusted ? "" : ` (${t("untrusted")})`}`,
          onSelect: async () => {
            if (m.id === "full") {
              const confirmed = await DialogConfirm.show(dialog, t("fullTitle"), t("fullMessage"), t("fullConfirm"))
              if (confirmed !== true) {
                dialog.replace(() => <DialogPermissions sessionID={props.sessionID} />)
                return
              }
            }
            try {
              const next = await api.setMode(m.id, props.sessionID)
              setStore({ status: next, sessionID: props.sessionID })
              if (next.notice) toast.show({ message: say(next.notice), variant: "warning", duration: 8000 })
              else toast.show({ message: t("modeUpdated"), variant: "success" })
              dialog.clear()
            } catch {
              toast.show({ message: t("modeFailed"), variant: "error" })
              dialog.replace(() => <DialogPermissions sessionID={props.sessionID} />)
            }
          },
        })
    for (const r of s.rules)
      out.push({
        title: `${r.action.padEnd(5)} ${r.rule}`,
        description: r.local ? t("remove") : r.source,
        value: `rule:${r.action}:${r.rule}:${r.source}`,
        category: t("rules"),
        onSelect: async () => {
          if (!r.local) return
          const ok = await DialogConfirm.show(dialog, t("removeRule"), r.rule, t("removeRule"))
          if (ok === true) {
            try {
              const result = await api.forget(r.rule)
              if (!result.removed) throw new Error("rule not removed")
              toast.show({ message: t("ruleRemoved"), variant: "success" })
            } catch {
              toast.show({ message: t("ruleRemoveFailed"), variant: "error" })
            }
          }
          dialog.replace(() => <DialogPermissions sessionID={props.sessionID} />)
        },
      })
    for (const d of s.denied)
      out.push({
        title: `${d.permission}: ${d.pattern}`,
        description: `${new Date(d.at).toLocaleTimeString()} · ${d.why}${d.rule ? ` · ${d.rule}` : ""}`,
        value: `denied:${d.at}:${d.pattern}`,
        category: t("denied"),
      })
    if (!out.length) out.push({ title: t("none"), value: "none", category: t("rules") })
    return out
  })

  return <DialogSelect title="/permissions" options={options()} />
}

/** First-run notice listing the active hooks; shown again only when the set of hooks changes. */
export async function showHooksNotice(deps: { sdk: ReturnType<typeof useSDK>; toast: ReturnType<typeof useToast> }) {
  const api = safetyApi(transportOf(deps.sdk))
  try {
    const s = await api.hooks()
    if (!s.enabled) return
    if (s.skippedProjectHooks && !s.noticeNeeded) deps.toast.show({ message: t("hooksSkipped"), variant: "info", duration: 6000 })
    if (!s.noticeNeeded) return
    const list = s.hooks.slice(0, 8).map((h) => `• ${h.event}${h.matcher !== "*" ? ` (${h.matcher})` : ""}: ${h.what.slice(0, 80)}`)
    deps.toast.show({ title: t("hooksTitle"), message: [t("hooksBody"), ...list, ...(s.hooks.length > 8 ? [`… +${s.hooks.length - 8}`] : [])].join("\n"), variant: "warning", duration: 15000 })
    await api.ackHooks(s.fingerprint)
  } catch {}
}
