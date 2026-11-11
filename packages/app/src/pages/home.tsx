import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { BetaWelcome } from "@/components/ezk/beta-welcome"
import { useProviders } from "@/hooks/use-providers"
import { hasEzkielynaCredential } from "@/components/ezk/first-run"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { createMemo, Show } from "solid-js"

export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const providers = useProviders(() => undefined)
  const hasCredential = createMemo(() =>
    hasEzkielynaCredential(providers.all().get(EZK.providerID) as { key?: unknown; source?: unknown } | undefined),
  )
  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <ScrollView
        class="h-full [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <div
          class={`
            mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
            lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-8 lg:px-6
          `}
        >
          <div class="lg:col-span-2">
            <Show when={hasCredential()}>
              <BetaWelcome
                version={InstallationVersion}
                focusedConnection={home.server.focused}
                directory={() => home.project.newSession()?.worktree ?? home.project.homedir()}
              />
            </Show>
          </div>
          <HomeProjects projects={projects} scroll={scroll} />
          <HomeSessions sessions={sessions} search={search} scroll={scroll} />
          <HomeUtilityNav
            class="flex lg:hidden"
            onOpenSettings={projects.utility.settings}
            onOpenHelp={projects.utility.help}
            language={projects.copy.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}
