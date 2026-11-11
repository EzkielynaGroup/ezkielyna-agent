// Ezkielyna Agent Wave B: desktop side of permission modes (S1) and project trust (S4).
// The server owns every decision (/ezk/permission, /ezk/trust); these components only show it and send choices back.
import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { confirmAction } from "@/components/confirm-action"
import { showToast } from "@/utils/toast"
import { authTokenFromCredentials } from "@/utils/server"
import type { EzkConnection } from "./client"

type Text = { en: string; id: string }
type Mode = "ask" | "acceptEdits" | "plan" | "safeAuto" | "full"

export interface PermissionStatus {
  flags: { modes: boolean; rules: boolean; hooks: boolean; trustUI: boolean }
  mode: { requested: Mode; effective: Mode; trusted: boolean }
  modes: { id: Mode; label: Text; hint: Text }[]
  notice?: Text
}

export interface TrustStatus {
  enabled: boolean
  root: string
  trusted: boolean
  list: string[]
  banner: Text
}

const words = {
  trust: { en: "Trust this folder", id: "Percayai folder ini" },
  keep: { en: "Keep untrusted", id: "Jangan percayai" },
  trustedTitle: { en: "Trusted folders", id: "Folder yang dipercaya" },
  trustedHint: {
    en: "Instructions, hooks, plugins and settings from these folders are used. Same list as `ezkielyna trust`.",
    id: "Instruksi, hooks, plugin, dan pengaturan dari folder ini dipakai. Daftarnya sama dengan `ezkielyna trust`.",
  },
  remove: { en: "Remove", id: "Hapus" },
  none: { en: "No trusted folders yet.", id: "Belum ada folder yang dipercaya." },
  mode: { en: "Permission mode", id: "Mode izin" },
  hooks: { en: "Hooks are active: these programs run automatically on agent events.", id: "Hooks aktif: program ini berjalan otomatis saat asisten bekerja." },
  ok: { en: "Got it", id: "Mengerti" },
  fullTitle: { en: "Enable full access mode?", id: "Aktifkan mode akses penuh?" },
  fullMessage: {
    en: "The agent can run actions with fewer permission checks in this folder.",
    id: "Agen dapat menjalankan tindakan dengan lebih sedikit pemeriksaan izin di folder ini.",
  },
  fullConfirm: { en: "Enable full access", id: "Aktifkan akses penuh" },
  keepSuccess: { en: "This folder will stay untrusted", id: "Folder ini tetap tidak dipercaya" },
  keepFailed: { en: "Could not save this preference", id: "Preferensi tidak dapat disimpan" },
}

export interface HooksStatus {
  enabled: boolean
  hooks: { event: string; matcher: string; what: string; scope: string }[]
  fingerprint: string
  noticeNeeded: boolean
}

export function ezkSafetyClient(conn: EzkConnection, f: typeof fetch = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch) {
  const call = async <T,>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const res = await f(`${conn.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        ...(conn.password ? { Authorization: `Basic ${authTokenFromCredentials({ username: conn.username, password: conn.password })}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
    return json
  }
  const q = (directory: string) => `directory=${encodeURIComponent(directory)}`
  return {
    permission: (directory: string, sessionID?: string) =>
      call<PermissionStatus>("GET", `/ezk/permission?${q(directory)}${sessionID ? `&sessionID=${encodeURIComponent(sessionID)}` : ""}`),
    setMode: (directory: string, mode: Mode, sessionID?: string) => call<PermissionStatus>("POST", "/ezk/permission/mode", { directory, mode, sessionID }),
    trust: (directory: string) => call<TrustStatus>("GET", `/ezk/trust?${q(directory)}`),
    hooks: (directory: string) => call<HooksStatus>("GET", `/ezk/hooks?${q(directory)}`),
    ackHooks: (directory: string, fingerprint: string) => call<{ ok: boolean }>("POST", "/ezk/hooks/ack", { directory, fingerprint }),
    trustFolder: (directory: string) => call<TrustStatus>("POST", "/ezk/trust", { directory }),
    removeTrusted: (directory: string, path: string) => call<{ removed: boolean; list: string[] }>("POST", "/ezk/trust/remove", { directory, path }),
    // a newly trusted folder must reload its config, agents and hooks: dispose that folder's instance
    reload: (directory: string) => call<boolean>("POST", `/instance/dispose?${q(directory)}`, {}).catch(() => false),
  }
}

const useConn = () => {
  const serverSDK = useServerSDK()
  return createMemo<EzkConnection>(() => {
    const http = serverSDK().server.http
    return { url: http.url, username: http.username, password: http.password }
  })
}

const useSay = () => {
  const language = useLanguage()
  return (t: Text | undefined) => (t ? (language.locale().toLowerCase().startsWith("id") ? t.id : t.en) : "")
}

/** Composer chip: pick the permission mode for this session (or for new sessions). Hidden while the modes flag is off. */
export function EzkPermissionModeSelect(props: { directory: string; sessionID?: string }) {
  const conn = useConn()
  const say = useSay()
  const dialog = useDialog()
  const language = useLanguage()
  const api = () => ezkSafetyClient(conn())
  const [status, { mutate }] = createResource(
    () => [props.directory, props.sessionID] as const,
    ([directory, sessionID]) => api().permission(directory, sessionID).catch(() => undefined),
  )
  const change = async (mode: Mode) => {
    if (mode === "full") {
      const confirmed = await confirmAction(dialog, {
        title: say(words.fullTitle),
        message: say(words.fullMessage),
        confirm: say(words.fullConfirm),
      })
      if (!confirmed) return false
    }
    try {
      const next = await api().setMode(props.directory, mode, props.sessionID)
      mutate(next)
      showToast({ variant: "success", title: language.t("ezk.action.permission.updated") })
      return true
    } catch {
      showToast({ variant: "error", title: language.t("ezk.action.permission.failed") })
      return false
    }
  }
  // `flags` may be missing when the server answers with an unexpected shape (older server, e2e mock): hide, never throw.
  return (
    <Show when={status()?.flags?.modes ? status() : undefined}>
      {(s) => (
        <span class="ml-1 inline-flex items-center gap-1" title={say(s().notice ?? s().modes.find((m) => m.id === s().mode.effective)?.hint)}>
          <select
            aria-label={say(words.mode)}
            class="h-6 rounded-full border border-v2-border-border-base bg-transparent px-2 text-[12px] text-v2-text-text-muted focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
            classList={{ "text-v2-text-text-danger": s().mode.effective === "full" }}
            value={s().mode.requested}
            onChange={(e) => {
              const element = e.currentTarget
              const previous = s().mode.requested
              void change(element.value as Mode).then((ok) => {
                if (!ok) element.value = previous
              })
            }}
          >
            <For each={s().modes}>{(m) => <option value={m.id}>{say(m.label)}</option>}</For>
          </select>
          <Show when={s().notice}>
            <span class="text-[11.5px] text-v2-text-text-warning">{say(s().notice)}</span>
          </Show>
        </span>
      )}
    </Show>
  )
}

/** "Folder ini belum dipercaya — instruksi & hooks proyek diabaikan" with Trust / Keep untrusted. */
export function EzkTrustBanner(props: { directory: string }) {
  const conn = useConn()
  const say = useSay()
  const dialog = useDialog()
  const language = useLanguage()
  const api = () => ezkSafetyClient(conn())
  const [status, { mutate }] = createResource(() => props.directory, (directory) => api().trust(directory).catch(() => undefined))
  const key = () => `ezk.trust.keep:${status()?.root ?? props.directory}`
  const [kept, setKept] = createSignal(readKept(key()))
  const visible = () => {
    const s = status()
    return !!s && s.enabled && !s.trusted && !kept() && !readKept(key())
  }
  const trust = async () => {
    const confirmed = await confirmAction(dialog, {
      title: language.t("ezk.action.trust.add.title"),
      message: language.t("ezk.action.trust.add.message", { directory: props.directory }),
      confirm: language.t("ezk.action.trust.add.confirm"),
    })
    if (!confirmed) return
    try {
      const next = await api().trustFolder(props.directory)
      mutate(next)
      if (!(await api().reload(props.directory))) throw new Error("reload failed")
      showToast({ variant: "success", title: language.t("ezk.action.trust.add.success") })
    } catch {
      showToast({ variant: "error", title: language.t("ezk.action.trust.add.failed") })
    }
  }
  const keep = () => {
    try {
      localStorage.setItem(key(), "1")
      setKept(true)
      showToast({ variant: "success", title: say(words.keepSuccess) })
    } catch {
      showToast({ variant: "error", title: say(words.keepFailed) })
    }
  }
  return (
    <Show when={visible()}>
      <div role="status" class="flex flex-wrap items-center justify-center gap-2 rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-02 px-3 py-2 text-[12.5px] text-v2-text-text-base">
        <span>{say(status()?.banner)}</span>
        <button type="button" class="h-6 rounded-full border border-v2-border-border-strong bg-v2-background-bg-layer-03 px-3 text-[12px] font-medium text-v2-text-text-base" onClick={() => void trust()}>
          {say(words.trust)}
        </button>
        <button type="button" class="h-6 rounded-full border border-v2-border-border-base px-3 text-[12px] text-v2-text-text-muted" onClick={keep}>
          {say(words.keep)}
        </button>
      </div>
    </Show>
  )
}

/** First-run notice listing the active hooks; acknowledged once per set of hooks. */
export function EzkHooksNotice(props: { directory: string }) {
  const conn = useConn()
  const say = useSay()
  const language = useLanguage()
  const api = () => ezkSafetyClient(conn())
  const [status, { mutate }] = createResource(() => props.directory, (directory) => api().hooks(directory).catch(() => undefined))
  const ack = async () => {
    const s = status()
    if (!s) return
    try {
      await api().ackHooks(props.directory, s.fingerprint)
      mutate({ ...s, noticeNeeded: false })
      showToast({ variant: "success", title: language.t("ezk.action.hooks.ack.success") })
    } catch {
      showToast({ variant: "error", title: language.t("ezk.action.hooks.ack.failed") })
    }
  }
  return (
    <Show when={status()?.enabled && status()?.noticeNeeded}>
      <div role="status" class="flex flex-col gap-1 rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-02 px-3 py-2 text-[12.5px] text-v2-text-text-base">
        <span>{say(words.hooks)}</span>
        <For each={status()?.hooks.slice(0, 8)}>
          {(h) => (
            <span class="truncate font-mono text-[11.5px] text-v2-text-text-muted">
              {h.event}
              {h.matcher !== "*" ? ` (${h.matcher})` : ""}: {h.what}
            </span>
          )}
        </For>
        <button type="button" class="self-end h-6 rounded-full border border-v2-border-border-base px-3 text-[12px] text-v2-text-text-muted" onClick={() => void ack()}>
          {say(words.ok)}
        </button>
      </div>
    </Show>
  )
}

function readKept(key: string) {
  try {
    return localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

/** Settings: the trusted-folder list with Remove (the same file `ezkielyna trust` writes). */
export function EzkTrustedFolders(props: { directory?: string }) {
  const conn = useConn()
  const say = useSay()
  const dialog = useDialog()
  const language = useLanguage()
  const api = () => ezkSafetyClient(conn())
  const directory = () => props.directory ?? "/"
  const [status, { refetch }] = createResource(directory, (dir) => api().trust(dir).catch(() => undefined))
  const remove = async (path: string) => {
    const confirmed = await confirmAction(dialog, {
      title: language.t("ezk.action.trust.remove.title"),
      message: language.t("ezk.action.trust.remove.message", { directory: path }),
      confirm: language.t("ezk.action.trust.remove.confirm"),
    })
    if (!confirmed) return
    try {
      const result = await api().removeTrusted(directory(), path)
      if (!result.removed) throw new Error("trust entry was not removed")
      if (!(await api().reload(path))) throw new Error("reload failed")
      await refetch()
      showToast({ variant: "success", title: language.t("ezk.action.trust.remove.success") })
    } catch {
      showToast({ variant: "error", title: language.t("ezk.action.trust.remove.failed") })
    }
  }
  return (
    <Show when={status()?.enabled}>
      <div class="settings-v2-section" data-action="settings-trusted-folders">
        <h3 class="settings-v2-section-title">{say(words.trustedTitle)}</h3>
        <p class="px-1 pb-2 text-[12.5px] text-v2-text-text-muted">{say(words.trustedHint)}</p>
        <div class="flex flex-col gap-1">
          <For each={status()?.list} fallback={<span class="px-1 text-[12.5px] text-v2-text-text-faint">{say(words.none)}</span>}>
            {(path) => (
              <div class="flex items-center gap-2 rounded-[8px] bg-v2-background-bg-layer-03 px-2 py-1.5 text-[13px] text-v2-text-text-base">
                <span class="min-w-0 flex-1 truncate" title={path}>
                  {path}
                </span>
                <button type="button" class="shrink-0 text-[12px] text-v2-text-text-muted hover:text-v2-text-text-base" onClick={() => void remove(path)}>
                  {say(words.remove)}
                </button>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
