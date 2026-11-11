// ALL flags on: a multi-turn coding task (edit, failing verify, fix, pass) and a background process with write_stdin.
import fs from "node:fs"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import {
  ALL_FLAGS, FLASH, QUIET, allowAll, boot, bodyText, expectCleanLogs, expectNoDuplicateReminders, expectNoDuplicateTools,
  expectStablePrefix, expectToolCallsAnswered, firstPrefixBreak, flagList, liveProcs, messages, newSession, promptAnswering,
  prompt, teardown, toolNames, toolParts, waitGone, POWER_USER,
} from "./helpers"

const rejections: unknown[] = []
process.on("unhandledRejection", (e) => rejections.push(e))
afterEach(async () => {
  await teardown()
  expect(rejections).toEqual([])
})

const manifest = (dir: string) =>
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.0.0", scripts: { typecheck: "test -f .verify-ok" } }))

for (const [name, set] of [["all flags", ALL_FLAGS], ["power user", POWER_USER]] as const) {
  test(`${name}: edit -> failing verify -> fix -> pass keeps invariants`, async () => {
    const { gw, srv } = await boot({
      flags: `${QUIET},${flagList(set)}`,
      seed: (d) => manifest(d.project),
      script: {
        [FLASH]: [
          { ok: true, tool: { name: "write", args: { filePath: "change.ts", content: "export const ok = true\n" } } },
          { ok: true, text: "The edit is ready." },
          { ok: true, tool: { name: "bash", args: { command: "bun run typecheck", description: "verify" } } },
          { ok: true, tool: { name: "write", args: { filePath: ".verify-ok", content: "fixed" } } },
          { ok: true, text: "Fixed the failing check." },
          { ok: true, tool: { name: "bash", args: { command: "bun run typecheck", description: "verify" } } },
          { ok: true, text: "Verification passed." },
        ],
      },
    })
    const ses = await newSession(srv, { permission: allowAll(srv) })
    const asked = await promptAnswering(srv, ses.id, "add change.ts and make sure the typecheck passes", FLASH, () => "once")
    await prompt(srv, ses.id, "thanks, summarise", FLASH)

    expect(fs.readFileSync(path.join(srv.dirs.project, "change.ts"), "utf8")).toBe("export const ok = true\n")
    const parts = toolParts(await messages(srv, ses.id))
    const bash = parts.filter((p: any) => p.tool === "bash")
    expect(bash.length).toBe(2)
    expect(bash[0].state.metadata?.exit).not.toBe(0)
    expect(bash[1].state.metadata?.exit).toBe(0)
    expect(parts.every((p: any) => p.state.status === "completed")).toBe(true)
    expect(asked.filter((a) => a.permission === "edit" && /\.(env|git)/.test(JSON.stringify(a)))).toEqual([])

    expectNoDuplicateTools(gw)
    expectNoDuplicateReminders(gw)
    expectToolCallsAnswered(gw)
    expectStablePrefix(gw)
    // Append-only history (BUG-1 fixed): the loop.verify reminder stays in later requests, so the prefix never breaks.
    expect(firstPrefixBreak(gw)).toBe(-1)
    // the failing verify output reaches the model
    expect(bodyText(gw.requests.at(-1)!)).toContain("verify")
    expectCleanLogs(srv)
    void toolNames
  }, 180_000)
}

test.skipIf(process.platform === "win32")("all flags: background process + write_stdin, no orphan after the session is deleted", async () => {
  const marker = "ezk-allflags-bg-4711"
  const cmd = `echo ready; i=0; while true; do read -t 1 line && echo "got:$line"; i=$((i+1)); done # ${marker}`
  const { gw, srv } = await boot({
    flags: `${QUIET},${flagList(ALL_FLAGS)}`,
    script: {
      [FLASH]: [
        { ok: true, tool: { name: "bash", args: { command: cmd, description: "interactive worker", run_in_background: true, tty: false } } },
        { ok: true, text: "started" },
        { ok: true, tool: { name: "write_stdin", args: { session_id: "bg_1", chars: "ping\n", yield_time_ms: 1500 } } },
        { ok: true, text: "answered" },
      ],
    },
  })
  const ses = await newSession(srv, { permission: allowAll(srv) })
  await promptAnswering(srv, ses.id, "start the worker", FLASH, () => "once")
  expect(liveProcs(marker).length).toBeGreaterThan(0)
  await promptAnswering(srv, ses.id, "send it ping", FLASH, () => "once")
  expect(bodyText(gw.requests.at(-1)!)).toContain("got:ping")
  expectNoDuplicateTools(gw)
  expectNoDuplicateReminders(gw)
  expectToolCallsAnswered(gw)
  expectStablePrefix(gw)

  await srv.api("DELETE", `/session/${ses.id}`)
  expect(await waitGone(marker)).toBe(true)
}, 180_000)

test.skipIf(process.platform === "win32")("all flags: a background process is gone when the server stops", async () => {
  const marker = "ezk-allflags-bg-9001"
  const { srv } = await boot({
    flags: `${QUIET},${flagList(ALL_FLAGS)}`,
    script: { [FLASH]: [{ ok: true, tool: { name: "bash", args: { command: `while true; do sleep 1; done # ${marker}`, description: "sleeper", run_in_background: true, tty: false } } }, { ok: true, text: "started" }] },
  })
  const ses = await newSession(srv, { permission: allowAll(srv) })
  await promptAnswering(srv, ses.id, "start sleeper", FLASH, () => "once")
  expect(liveProcs(marker).length).toBeGreaterThan(0)
  await teardown() // kills the server with SIGTERM, like closing the app
  expect(await waitGone(marker, 10_000)).toBe(true)
}, 120_000)
