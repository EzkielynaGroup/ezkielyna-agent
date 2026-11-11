// ALL flags (and the "safe" subset): classifier blocks a destructive command, a hook blocks an edit to .env, and protected
// paths are never written without a prompt even though modes would auto-allow ordinary edits.
import fs from "node:fs"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import {
  ALL_FLAGS, FLASH, MINI, PRO, QUIET, SAFE, boot, bodyText, expectCleanLogs, expectNoDuplicateReminders, expectNoDuplicateTools,
  expectToolCallsAnswered, flagList, messages, newSession, prompt, promptAnswering, sha, teardown, toolParts,
} from "./helpers"

const rejections: unknown[] = []
process.on("unhandledRejection", (e) => rejections.push(e))
afterEach(async () => {
  await teardown()
  expect(rejections).toEqual([])
})

const BLOCK = { ok: true as const, text: JSON.stringify({ decision: "block", reason: "destructive and not requested" }) }

for (const [name, set] of [["all flags", ALL_FLAGS], ["safe subset", SAFE]] as const) {
  test(`${name}: classifier blocks a destructive command and nothing is deleted`, async () => {
    const { gw, srv } = await boot({
      flags: `${QUIET},${flagList(set)}`,
      mode: "safeAuto",
      seed: (d) => {
        fs.mkdirSync(path.join(d.project, "victim"), { recursive: true })
        fs.writeFileSync(path.join(d.project, "victim", "keep.txt"), "keep\n")
      },
      script: {
        [PRO]: [
          { ok: true, tool: { name: "bash", args: { command: "rm -rf victim", description: "clean" } } },
          { ok: true, text: "I will not delete it." },
        ],
        // the classifier call goes to the light model of the key; both candidates answer "block"
        [FLASH]: [BLOCK, BLOCK],
        [MINI]: [BLOCK, BLOCK],
      },
    })
    const ses = await newSession(srv)
    const asked = await promptAnswering(srv, ses.id, "tidy the workspace a little", PRO, () => "reject")
    expect(fs.existsSync(path.join(srv.dirs.project, "victim", "keep.txt"))).toBe(true)
    expect(gw.requests.some((r) => r.system.includes("You are a safety gate"))).toBe(true)
    const tools = toolParts(await messages(srv, ses.id))
    expect(tools.find((p: any) => p.tool === "bash")?.state.status).toBe("error")
    // either the classifier blocked it without a prompt, or the user was asked and said no: never run
    expect(asked.length).toBeLessThanOrEqual(1)
    expectNoDuplicateTools(gw)
    expectNoDuplicateReminders(gw)
    expectToolCallsAnswered(gw)
    expectCleanLogs(srv)
  }, 180_000)
}

for (const [name, set] of [["all flags", ALL_FLAGS], ["safe subset", SAFE]] as const) {
  test(`${name}: a PreToolUse hook blocks an edit to .env and the model sees the reason`, async () => {
    const { gw, srv } = await boot({
      flags: `${QUIET},${flagList(set)}`,
      seed: (d) => fs.writeFileSync(path.join(d.project, ".env"), "TOKEN=fake-value-for-test\n"),
      settings: { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "echo 'never edit .env' >&2; exit 2" }] }] } },
      script: {
        [FLASH]: [
          { ok: true, tool: { name: "write", args: { filePath: ".env", content: "TOKEN=changed\n" } } },
          { ok: true, text: "understood" },
        ],
      },
    })
    const before = sha(path.join(srv.dirs.project, ".env"))
    const ses = await newSession(srv)
    await promptAnswering(srv, ses.id, "set the token", FLASH, () => "reject")
    expect(sha(path.join(srv.dirs.project, ".env"))).toBe(before)
    expect(bodyText(gw.requests.at(-1)!)).toContain("never edit .env")
    expectToolCallsAnswered(gw)
    expectNoDuplicateReminders(gw)
    expectCleanLogs(srv)
  }, 180_000)
}

test("all flags: protected paths are never written without asking, even in Edit otomatis", async () => {
  const targets = [".env", ".git/hooks/pre-commit", "ezkielyna.json", "AGENTS.md", ".github/workflows/ci.yml"]
  const { gw, srv } = await boot({
    flags: `${QUIET},${flagList(ALL_FLAGS)}`,
    mode: "acceptEdits",
    seed: (d) => {
      fs.writeFileSync(path.join(d.project, ".env"), "A=1\n")
      fs.writeFileSync(path.join(d.project, "AGENTS.md"), "rules\n")
      // already has $schema, so the config loader does not rewrite it (see BUG-2 in REPORT-allflags.md)
      fs.writeFileSync(path.join(d.project, "ezkielyna.json"), '{ "$schema": "https://opencode.ai/config.json" }\n')
    },
    // a rejected edit ends the turn, so each target gets its own prompt and one scripted write
    script: { [FLASH]: targets.map((t) => ({ ok: true as const, tool: { name: "write", args: { filePath: t, content: "pwned\n" } } })) },
  })
  const files = targets.map((t) => path.join(srv.dirs.project, t))
  const before = files.map(sha)
  const ses = await newSession(srv)
  const asked: any[] = []
  for (const t of targets) asked.push(...(await promptAnswering(srv, ses.id, `update ${t}`, FLASH, () => "reject")))
  expect(files.map(sha)).toEqual(before)
  expect(asked.filter((a) => a.permission === "edit").length).toBe(targets.length)
  expectToolCallsAnswered(gw)
  expectNoDuplicateTools(gw)
  expectNoDuplicateReminders(gw)
  expectCleanLogs(srv)
}, 180_000)

test("BUG-2: loading never rewrites a project ezkielyna.json without $schema", async () => {
  const { srv } = await boot({
    flags: `${QUIET},${flagList(ALL_FLAGS)}`,
    mode: "acceptEdits",
    seed: (d) => fs.writeFileSync(path.join(d.project, "ezkielyna.json"), "{}\n"),
    script: { [FLASH]: [] },
  })
  await newSession(srv)
  expect(fs.readFileSync(path.join(srv.dirs.project, "ezkielyna.json"), "utf8")).toBe("{}\n")
}, 180_000)

test("safe subset: an ordinary edit still works after the protected ones were refused", async () => {
  const { srv } = await boot({
    flags: `${QUIET},${flagList(SAFE)}`,
    mode: "acceptEdits",
    script: { [FLASH]: [{ ok: true, tool: { name: "write", args: { filePath: "notes.md", content: "ok\n" } } }, { ok: true, text: "written" }] },
  })
  const ses = await newSession(srv)
  const asked = await promptAnswering(srv, ses.id, "write notes", FLASH, () => "reject")
  expect(asked).toEqual([])
  expect(fs.readFileSync(path.join(srv.dirs.project, "notes.md"), "utf8")).toBe("ok\n")
  void prompt
}, 120_000)
