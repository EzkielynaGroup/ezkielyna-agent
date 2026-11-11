import { createMemo, createResource, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import type { createHomeController } from "@/pages/home/home-controller"
import type { createHomeSessionsController } from "@/pages/home/home-sessions-controller"
import { type EzkConnection, ezkClient } from "./client"
import { DialogEzkMemory } from "./memory-dialog"
import { useEzkRouteLabels } from "./route-store"
import { DialogEzkSearch } from "./search-dialog"
import { ezkT } from "./strings"
import { laneClient, laneT } from "./lane-client"
import { sessionIDFromPath } from "./status-model"
import { EzkStatusBlock, EzkTasksPanel } from "./status-panel"
import { DialogEzkTasks } from "./tasks-dialog"
import { showToast } from "@/utils/toast"

// Two sidebar rows (Memory, Search sessions) + registration of the per-turn model badge resolver. The only edit in the
// shared sidebar file is mounting this component, so upstream/hardening merges stay trivial.
export function EzkSidebarRows(props: {
  home: ReturnType<typeof createHomeController>
  sessions: ReturnType<typeof createHomeSessionsController>
  itemClass: string
  labelClass: string
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const t = createMemo(() => ezkT(language.locale()))

  const conn = createMemo<EzkConnection | undefined>(() => {
    const c = props.home.server.focused()
    return c ? { url: c.http.url, username: c.http.username, password: c.http.password } : undefined
  })

  useEzkRouteLabels({ connection: conn, language: () => language.locale() })

  const [memoryStatus, { refetch: refetchMemory }] = createResource(
    conn,
    (c) => ezkClient(c).memory().catch(() => undefined),
  )

  const dismissMemoryNotice = async () => {
    const c = conn()
    if (!c) return
    try {
      await ezkClient(c).acceptNotice()
      await refetchMemory()
      showToast({ variant: "success", title: language.t("ezk.action.memory.notice.dismissed") })
    } catch {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
    }
  }

  const openMemory = () => {
    const c = conn()
    if (c) dialog.show(() => <DialogEzkMemory conn={c} lang={language.locale()} sessionID={currentSessionID()} />)
  }
  const openSearch = () => {
    const c = conn()
    if (!c) return
    dialog.show(() => (
      <DialogEzkSearch
        conn={c}
        lang={language.locale()}
        exclude={currentSessionID()}
        onOpen={(sessionID, hit) => {
          dialog.close()
          const record = props.sessions.data.searchRecords().find((r) => r.session.id === sessionID)
          const session = record?.session ?? (hit?.directory ? ({ id: sessionID, directory: hit.directory, title: hit.title ?? "" } as any) : undefined)
          if (session) props.sessions.session.open(session)
        }}
      />
    ))
  }

  const openTasks = () => {
    const c = conn()
    if (c) dialog.show(() => <DialogEzkTasks conn={c} lang={language.locale()} sessionID={currentSessionID()} />)
  }

  // The tasks row and panel exist only while the exec feature is on (the server reports it).
  const [tasksOn] = createResource(conn, (c) => laneClient(c).tasks().then((r) => r.enabled).catch(() => false))
  const location = useLocation()
  const sessionID = createMemo(() => sessionIDFromPath(location.pathname + location.hash))
  const directory = createMemo(() => props.home.project.newSession()?.worktree)

  return (
    <>
      <Show when={memoryStatus.latest?.enabled && !memoryStatus.latest?.noticeAccepted}>
        <div
          data-component="ezk-memory-notice"
          role="status"
          class="ezk-memory-info-bar flex min-w-0 items-center gap-2 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5 text-[11px] text-v2-text-text-muted"
        >
          <Icon name="brain" size="small" />
          <span class="min-w-0 flex-1 truncate" title={t()("memory.notice")}>
            {t()("memory.notice.inline")}
          </span>
          <button
            type="button"
            class="shrink-0 rounded px-1 text-[14px] leading-none text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"
            aria-label={t()("memory.dismiss")}
            title={t()("memory.dismiss")}
            onClick={() => void dismissMemoryNotice()}
          >
            ×
          </button>
        </div>
      </Show>
      <button type="button" class={props.itemClass} onClick={openSearch} aria-label={t()("sidebar.search")}>
        <IconV2 name="magnifying-glass" />
        <span class={props.labelClass}>{t()("sidebar.search")}</span>
      </button>
      <button type="button" class={props.itemClass} onClick={openMemory} aria-label={t()("sidebar.memory")}>
        <Icon name="brain" size="small" />
        <span class={props.labelClass}>{t()("sidebar.memory")}</span>
      </button>
      <Show when={tasksOn.latest}>
      <button type="button" class={props.itemClass} onClick={openTasks} aria-label={laneT(language.locale())("sidebar.tasks")}>
        <IconV2 name="monitor" />
        <span class={props.labelClass}>{laneT(language.locale())("sidebar.tasks")}</span>
      </button>
      </Show>
      <Show when={conn()}>
        {(c) => (
          <>
            <EzkStatusBlock conn={c()} directory={directory()} sessionID={sessionID()} lang={language.locale()} />
            <Show when={tasksOn.latest}>
              <EzkTasksPanel conn={c()} sessionID={sessionID()} lang={language.locale()} />
            </Show>
          </>
        )}
      </Show>
    </>
  )
}

/** The session open in the focused window, taken from the URL (/:dir/session/:id). Undefined on the home screen. */
function currentSessionID(): string | undefined {
  const m = /\/session\/([^/?#]+)/.exec(window.location.pathname + window.location.hash)
  return m?.[1]
}
