import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { compareSessionTime, displayName, projectForSession } from "@/pages/layout/helpers"
import { directoryMatchKey } from "@/utils/path-key"

export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

export function homeProjectDirectories(selected: LocalProject | undefined, projects: LocalProject[]) {
  if (!selected) return projects.flatMap(directories)
  return directories(selected)
}

/** The project a session belongs to: the one that owns its folder, else the one with its project id. */
export function findHomeSessionProject(session: Session, projects: LocalProject[], byID?: Map<string, LocalProject>) {
  const directory = directoryMatchKey(session.directory)
  return (
    projects.find(
      (item) =>
        directoryMatchKey(item.worktree) === directory ||
        item.sandboxes?.some((sandbox) => directoryMatchKey(sandbox) === directory),
    ) ?? projectForSession(session, projects, byID)
  )
}

export function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}): HomeSessionRecord[] {
  // The server stores a session under the real path of its folder; the project list keeps the path the app opened.
  const directories = new Set(input.projectDirectories().map(directoryMatchKey))
  const sessions = input.sessions().filter((session) => directories.has(directoryMatchKey(session.directory)))
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort(compareSessionTime)
    .flatMap((session) => {
      const project = findHomeSessionProject(session, input.projects(), input.projectByID())
      if (!project) return []
      return { session, project, projectName: displayName(project) }
    })
}

/** Records shown under one project in the sidebar (newest first, at most `limit`). */
export function recentSessionsForProject(
  records: HomeSessionRecord[],
  worktree: string,
  sandboxes: string[] | undefined,
  limit: number,
) {
  const worktreeKey = directoryMatchKey(worktree)
  const keys = new Set([worktree, ...(sandboxes ?? [])].map(directoryMatchKey))
  return records
    .filter(
      (record) =>
        directoryMatchKey(record.project.worktree) === worktreeKey || keys.has(directoryMatchKey(record.session.directory)),
    )
    .slice(0, limit)
}
