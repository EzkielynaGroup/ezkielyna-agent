import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { directoryMatchKey, pathKey } from "@/utils/path-key"
import { buildHomeSessionRecords, recentSessionsForProject } from "./home-session-records"

// Packaged ezk.8 smoke on macOS: the app opened "Default Project" as /var/folders/.../Default Project, the server stored the
// session as /private/var/folders/.../Default Project, and the sidebar kept saying "No sessions yet".
const APP_DIR = "/var/folders/fq/x/T/ezk-desk-AbC/user/Default Project"
const SERVER_DIR = "/private" + APP_DIR

const project = (worktree: string, extra: Partial<LocalProject> = {}): LocalProject => ({
  id: "global",
  worktree,
  expanded: true,
  ...extra,
})

const session = (id: string, directory: string, updated = 1): Session =>
  ({
    id,
    slug: id,
    projectID: "global",
    directory,
    title: "Hello script",
    version: "",
    time: { created: updated, updated },
  }) as Session

const build = (sessions: Session[], projects: LocalProject[], selected?: LocalProject) =>
  buildHomeSessionRecords({
    sessions: () => sessions,
    projectDirectories: () => (selected ? [selected.worktree] : projects.flatMap((p) => [p.worktree, ...(p.sandboxes ?? [])])),
    projects: () => projects,
    projectByID: () => new Map(projects.flatMap((p) => (p.id ? [[p.id, p] as const] : []))),
  })

describe("directoryMatchKey", () => {
  test("folds the macOS /private aliases and nothing else", () => {
    expect(directoryMatchKey("/private/var/folders/a")).toBe("/var/folders/a" as never)
    expect(directoryMatchKey("/private/tmp")).toBe("/tmp" as never)
    expect(directoryMatchKey("/private/etc/hosts")).toBe("/etc/hosts" as never)
    expect(directoryMatchKey("/private/var/")).toBe("/var" as never)
    expect(directoryMatchKey("/private/varnish")).toBe("/private/varnish" as never)
    expect(directoryMatchKey("/private/other/x")).toBe("/private/other/x" as never)
    expect(directoryMatchKey("/home/me/private/var/x")).toBe("/home/me/private/var/x" as never)
    expect(directoryMatchKey("C:\\Users\\me\\")).toBe("C:/Users/me" as never)
  })

  test("pathKey itself is unchanged, so persisted workspace keys stay stable", () => {
    expect(pathKey("/private/var/x")).toBe("/private/var/x" as never)
  })
})

describe("home session records", () => {
  test("a session stored under the resolved /private path is listed for the project opened as /var", () => {
    const p = project(APP_DIR)
    const records = build([session("ses_1", SERVER_DIR)], [p])
    expect(records.map((r) => r.session.id)).toEqual(["ses_1"])
    expect(records[0].project).toBe(p)
    expect(recentSessionsForProject(records, p.worktree, p.sandboxes, 5).map((r) => r.session.id)).toEqual(["ses_1"])
  })

  test("the same holds when only one project is selected", () => {
    const p = project(APP_DIR)
    expect(build([session("ses_1", SERVER_DIR)], [p], p)).toHaveLength(1)
  })

  test("exact matches still work and other folders are still filtered out", () => {
    const p = project("/Users/me/app", { id: "abc" })
    const records = build([session("ses_1", "/Users/me/app"), session("ses_2", "/Users/me/other")], [p])
    expect(records.map((r) => r.session.id)).toEqual(["ses_1"])
  })

  test("a session in a sandbox directory is grouped under its project", () => {
    const p = project("/Users/me/app", { id: "abc", sandboxes: ["/var/work/app-wt"] })
    const records = build([session("ses_1", "/private/var/work/app-wt")], [p])
    expect(recentSessionsForProject(records, p.worktree, p.sandboxes, 5)).toHaveLength(1)
  })

  test("sessions of one project do not leak into another and the limit applies", () => {
    const a = project(APP_DIR)
    const b = project("/Users/me/b", { id: "b" })
    const records = build(
      [session("ses_a1", SERVER_DIR, 3), session("ses_a2", APP_DIR, 2), session("ses_b", "/Users/me/b", 1)],
      [a, b],
    )
    expect(recentSessionsForProject(records, a.worktree, undefined, 1).map((r) => r.session.id)).toEqual(["ses_a1"])
    expect(recentSessionsForProject(records, b.worktree, undefined, 5).map((r) => r.session.id)).toEqual(["ses_b"])
  })
})
