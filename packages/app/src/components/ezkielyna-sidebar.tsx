import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useCommand } from "@/context/command"
import { Mark } from "@opencode-ai/ui/logo"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLocation } from "@solidjs/router"
import { useQueryClient } from "@tanstack/solid-query"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { SDKProvider } from "@/context/sdk"
import { useProviders } from "@/hooks/use-providers"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeProjectsController } from "@/pages/home/home-projects-controller"
import { createHomeSessionsController } from "@/pages/home/home-sessions-controller"
import { recentSessionsForProject } from "@/pages/home/home-session-records"
import { displayName } from "@/pages/layout/helpers"
import { createFocusPoll } from "@/utils/focus-poll"
import { formatIdr, formatTokens, formatUsd } from "@opencode-ai/core/ezkielyna-account"
import type { AccountResponse } from "./ezk/status-client"
import { statusClient } from "./ezk/status-client"
import { EzkSidebarRows } from "./ezk/sidebar-rows"
import { KeyGroupHint } from "./ezk/key-group-hint"
import { EzkTestProfileBadge } from "./ezk/test-profile-badge"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { DialogChangeEzkielynaKey } from "./ezk/dialog-change-key"
import { hasEzkielynaCredential, shouldOpenFirstRun } from "./ezk/first-run"
import { EmptyStateV2 } from "@opencode-ai/ui/v2/empty-state-v2"

// Ezkielyna Agent: persistent left sidebar (new task, plugins, local/cloud, projects with recent tasks, account).
// Layout/UX pattern only; built from OpenCode's own home controllers so projects, sessions and tabs stay in sync.

const SESSIONS_PER_PROJECT = 5

const item =
  "flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[13px] leading-none text-v2-text-text-base transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-v2-border-border-focus focus-visible:bg-v2-overlay-simple-overlay-hover max-[900px]:justify-center max-[900px]:px-0"
const label = "min-w-0 flex-1 truncate max-[900px]:hidden"

export function EzkielynaSidebar() {
  const language = useLanguage()
  const dialog = useDialog()
  const command = useCommand()
  const home = createHomeController()
  const sessions = createHomeSessionsController(home)
  const projectsCtl = createHomeProjectsController(home)
  const providers = useProviders(() => undefined)
  const [open, setOpen] = createStore<Record<string, boolean>>({})
  const t = language.t as (key: string) => string

  function openBugReport() {
    const conn = home.server.focused()
    if (!conn) return
    const current = { url: conn.http.url, username: conn.http.username, password: conn.http.password }
    void import("./ezk/bugreport-dialog").then(({ DialogBugReport }) => {
      void dialog.show(() => <DialogBugReport conn={current} />)
    })
  }

  command.register("ezk-sidebar", () => [
    {
      id: "bugreport.open",
      title: t("ezk.bugReport.title"),
      category: t("command.category.help"),
      onSelect: openBugReport,
    },
  ])

  const projects = createMemo(() => home.project.list())
  const keyGroupModels = createMemo(() => {
    const provider = providers.all().get("ezkielyna") as
      | { models?: Record<string, { id: string; groups?: string[]; groupRatio?: Record<string, number> }> }
      | undefined
    return Object.values(provider?.models ?? {})
  })

  // The task list comes from the home session index, which only refetches on mount. The sidebar never remounts, so it
  // refreshes the index after navigation (a new task opens a new route), when the window regains focus, and every 20 s.
  const queryClient = useQueryClient()
  const location = useLocation()
  const refreshTasks = () =>
    void queryClient.invalidateQueries({ queryKey: home.server.focusedSync().homeSessions.indexKey })
  createEffect(() => {
    void location.pathname
    const timer = setTimeout(refreshTasks, 600)
    onCleanup(() => clearTimeout(timer))
  })
  createEffect(() => {
    onCleanup(createFocusPoll(refreshTasks, 20_000, 120_000))
  })

  // Plan name + remaining quota (adapter in ezkielyna-account.ts), refreshed every 60 s (the server allows 20 requests a minute per key) and when the window regains focus.
  const [account, setAccount] = createSignal<AccountResponse>()
  const [accountRefresh, setAccountRefresh] = createSignal(0)
  const ezkProvider = createMemo(
    () =>
      providers.all().get(EZK.providerID) as { key?: string; source?: "env" | "api" | "config" | "custom" } | undefined,
  )
  const accountData = createMemo(() => {
    const result = account()
    return result?.state === "available" ? result.account : undefined
  })
  const accountRefused = () => account()?.state === "refused"
  // The key is in the OS keychain but could not be read: say so instead of "No API key" (ezk.8 diagnosis, 2 Nov 2026).
  const keychainUnreadable = () => {
    const result = account()
    return result?.state === "missing" && result.reason === "keychain-unreadable"
  }
  const refreshAccount = async () => {
    setAccount(undefined)
    setAccountRefresh((value) => value + 1)
    await home.server.focusedSync().refreshProviders()
  }
  createEffect(() => {
    void accountRefresh()
    const server = home.server.focused()
    if (!server) return setAccount({ state: "missing" })
    const conn = { url: server.http.url, username: server.http.username, password: server.http.password }
    let active = true
    let refused = false
    const load = () => {
      if (refused) return
      void statusClient(conn)
        .account()
        .then((result) => {
          if (!active) return
          setAccount(result)
          refused = result.state === "refused"
        })
        .catch(() => active && setAccount({ state: "unavailable" }))
    }
    load()
    const stop = createFocusPoll(load, 60_000, 5 * 60_000)
    onCleanup(() => {
      active = false
      stop()
    })
  })
  const quotaLine = createMemo(() => {
    const a = accountData()
    if (!a) return undefined
    const parts: string[] = []
    if (a.plan) parts.push(a.plan)
    if (a.planStatus === "expired") parts.push(t("ezk.sidebar.expired"))
    else if (a.planStatus === "capped") parts.push(t("ezk.sidebar.capped"))
    else if (a.remainingTokens !== undefined)
      parts.push(`${formatTokens(a.remainingTokens)} ${t("ezk.sidebar.tokensLeftToday")}`)
    else if (a.unlimited) parts.push(t("ezk.sidebar.unlimited"))
    else if (a.remainingUsd !== undefined)
      parts.push(`${t("ezk.sidebar.balance")} ${formatUsd(a.remainingUsd)} (\u2248 ${formatIdr(a.remainingUsd)})`)
    return parts.join(" \u00b7 ") || undefined
  })
  const quotaTitle = createMemo(() => {
    const a = accountData()
    if (!a) return undefined
    const lines: string[] = []
    if (a.label) lines.push(a.label)
    if (a.resetsAt) lines.push(`${t("ezk.sidebar.resets")} ${new Date(a.resetsAt).toLocaleString()}`)
    if (a.expiresAt) lines.push(`${t("ezk.sidebar.validUntil")} ${new Date(a.expiresAt).toLocaleDateString()}`)
    return lines.join("\n") || undefined
  })
  const hasCredential = createMemo(() => hasEzkielynaCredential(ezkProvider()))
  const isNewTask = () => !location.pathname.includes("/session/")
  const [firstRunOpened, setFirstRunOpened] = createSignal(false)

  function changeKey(firstRun = !hasCredential()) {
    void dialog.push(() => <DialogChangeEzkielynaKey firstRun={firstRun} refresh={refreshAccount} />)
  }

  createEffect(() => {
    const ready = !!home.server.focused() && home.server.focusedSync().ready
    // Only a v1 provider list carries key/source; under v2 (or before detection) a missing credential is not evidence.
    const credentialKnown = home.server.focusedContext()?.sdk.protocolKind() === "v1"
    if (
      !shouldOpenFirstRun({ ready, hasCredential: hasCredential(), alreadyOpened: firstRunOpened(), credentialKnown })
    )
      return
    setFirstRunOpened(true)
    changeKey(true)
  })
  // The server stores a session under the real path of its folder (/private/var/... on macOS) while the project keeps the
  // path the app opened (/var/...), so the match goes through recentSessionsForProject, not a plain path comparison.
  const recent = (worktree: string, sandboxes: string[] | undefined) =>
    recentSessionsForProject(sessions.data.searchRecords(), worktree, sandboxes, SESSIONS_PER_PROJECT)
  const isOpen = (worktree: string, index: number) => open[worktree] ?? index === 0

  function newTask() {
    const conn = home.server.focused()
    const project = home.project.newSession()
    if (!conn || !project) return
    home.project.openProjectNewSession(conn, project.worktree)
  }

  // The MCP dialog reads the directory-scoped SDK/sync contexts, which only exist inside a project route. The sidebar sits
  // above those routes, so the dialog is mounted inside its own SDKProvider for the current project (upstream opens it
  // from within the session page, where the provider already exists).
  function openPlugins() {
    const directory = home.project.newSession()?.worktree
    if (!directory) return
    void import("@/components/dialog-select-mcp").then(({ DialogSelectMcp }) => {
      void dialog.show(() => (
        <SDKProvider directory={directory}>
          <DialogSelectMcp />
        </SDKProvider>
      ))
    })
  }

  return (
    <>
      <aside
        data-component="ezkielyna-sidebar"
        class="ezk-sidebar flex w-[264px] shrink-0 flex-col gap-3 rounded-[14px] bg-v2-background-bg-layer-01 p-2 max-[900px]:w-[52px]"
      >
        <button
          type="button"
          class="ezk-sidebar-new-task flex h-9 w-full items-center gap-2 rounded-[10px] bg-v2-background-bg-accent px-3 text-[13px] font-[560] text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-v2-border-border-focus max-[900px]:justify-center max-[900px]:px-0"
          classList={{ "ezk-nav-active": isNewTask() }}
          onClick={newTask}
          disabled={!home.project.newSession()}
          aria-label={t("ezk.sidebar.newTask")}
        >
          <IconV2 name="plus" />
          <span class="max-[900px]:hidden">{t("ezk.sidebar.newTask")}</span>
        </button>

        <nav class="flex flex-col gap-0.5">
          <EzkSidebarRows home={home} sessions={sessions} itemClass={item} labelClass={label} />
          <button
            type="button"
            class={item}
            onClick={openPlugins}
            disabled={!home.project.newSession()}
            aria-label={t("ezk.sidebar.plugins")}
          >
            <IconV2 name="grid-plus" />
            <span class={label}>{t("ezk.sidebar.plugins")}</span>
          </button>
        </nav>

        <div class="flex min-h-0 flex-1 flex-col gap-1">
          <div class="flex h-6 items-center justify-between px-2 text-[11px] font-[560] uppercase tracking-wide text-v2-text-text-faint max-[900px]:hidden">
            <span>{t("ezk.sidebar.projects")}</span>
            <button
              type="button"
              class="flex size-5 items-center justify-center rounded-[6px] text-v2-icon-icon-base hover:bg-v2-overlay-simple-overlay-hover"
              aria-label={t("ezk.sidebar.addProject")}
              onClick={() => {
                const conn = home.server.focused()
                if (conn) projectsCtl.project.choose(conn)
              }}
            >
              <IconV2 name="folder-add-left" size="small" />
            </button>
          </div>
          <div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            <For each={projects()}>
              {(project, index) => {
                const rows = createMemo(() => recent(project.worktree, project.sandboxes))
                return (
                  <div class="flex flex-col">
                    <button
                      type="button"
                      class={item}
                      title={project.worktree}
                      onClick={() => setOpen(project.worktree, !isOpen(project.worktree, index()))}
                      aria-expanded={isOpen(project.worktree, index())}
                    >
                      <IconV2 name="folder" class="shrink-0" />
                      <span class={label}>{displayName(project)}</span>
                      <IconV2
                        name="chevron-down"
                        size="small"
                        class={"shrink-0 " + (isOpen(project.worktree, index()) ? "" : "-rotate-90")}
                      />
                    </button>
                    <Show when={isOpen(project.worktree, index())}>
                      <div class="ml-4 flex flex-col gap-0.5 border-l border-v2-border-border-muted pl-2 max-[900px]:hidden">
                        <For
                          each={rows()}
                          fallback={
                            <EmptyStateV2
                              class="ezk-sidebar-empty"
                              size="compact"
                              icon="workspace"
                              title={t("ezk.empty.sessions.title")}
                              description={t("ezk.empty.sessions.description")}
                              action={{ label: t("ezk.empty.sessions.action"), onClick: newTask }}
                            />
                          }
                        >
                          {(record) => (
                            <button
                              type="button"
                              class="h-7 w-full truncate rounded-[6px] px-2 text-left text-[12.5px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-v2-border-border-focus"
                              title={record.session.title}
                              onClick={() => sessions.session.open(record.session)}
                            >
                              {record.session.title || t("ezk.sidebar.untitled")}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </div>

        <button type="button" class={item} onClick={openBugReport} aria-label={t("ezk.bugReport.title")}>
          <IconV2 name="help" />
          <span class={label}>{t("ezk.bugReport.title")}</span>
        </button>

        <div class="ezk-account-card" data-component="ezk-account-card">
          <div class="ezk-account-head">
            <Mark class="size-7 shrink-0 rounded-[6px]" />
            <span class="min-w-0 flex-1 truncate">Ezkielyna</span>
            <EzkTestProfileBadge />
            <TooltipV2 placement="top" value={t("ezk.sidebar.settings")}>
              <button
                type="button"
                class="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-v2-icon-icon-base hover:bg-v2-overlay-simple-overlay-hover"
                aria-label={t("ezk.sidebar.settings")}
                onClick={() => projectsCtl.utility.settings()}
              >
                <IconV2 name="settings-gear" />
              </button>
            </TooltipV2>
          </div>
          <div class="ezk-account-balance-label">
            <span>{t("ezk.sidebar.balance")}</span>
            <a href={EZK.storeURL} target="_blank" rel="noreferrer">
              {t("ezk.sidebar.topUp")}
            </a>
          </div>
          <div
            class="ezk-account-balance"
            classList={{ "ezk-account-balance--status": accountData()?.remainingUsd === undefined }}
            title={[quotaLine(), quotaTitle()].filter(Boolean).join("\n")}
          >
            <Show
              when={accountData()?.remainingUsd !== undefined}
              fallback={
                <Show when={accountRefused()} fallback={quotaLine() ?? t("ezk.sidebar.balanceLoading")}>
                  <span class="ezk-account-refused">
                    {t("ezk.sidebar.keyRefused")}
                    <button type="button" onClick={() => changeKey(false)}>
                      {t("ezk.sidebar.changeKey")}
                    </button>
                  </span>
                </Show>
              }
            >
              {formatIdr(accountData()!.remainingUsd!)}
            </Show>
          </div>
          <div class="ezk-account-key-group">
            <div class="ezk-account-balance-label">
              <span>{t("ezk.sidebar.keyGroup")}</span>
            </div>
            <Show
              when={hasCredential()}
              fallback={
                <button type="button" class="ezk-account-add-key" onClick={() => changeKey(!keychainUnreadable())}>
                  {keychainUnreadable() ? t("ezk.sidebar.keyKeychainUnreadable") : t("ezk.sidebar.noKeyAdd")}
                </button>
              }
            >
              <Show
                when={keyGroupModels().length > 0}
                fallback={<span class="text-[11px] text-v2-text-text-muted">{t("ezk.sidebar.keyGroupUnknown")}</span>}
              >
                <KeyGroupHint models={keyGroupModels()} compact />
              </Show>
              <button type="button" class="ezk-account-change-key" onClick={() => changeKey(false)}>
                {t("ezk.sidebar.changeKey")}
              </button>
            </Show>
          </div>
        </div>
      </aside>
    </>
  )
}
