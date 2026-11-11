// ezk.8: context compaction with model metadata ON (models.metadata, the ezk.8 default).
// With metadata ON the policy's agentContext becomes the model's real window and automatic compaction triggers at 90% of it.
// Mock gateway on 127.0.0.1 and a fake key only: no paid model is called.
import fs from "node:fs"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import { type Step, FLASH, QUIET, allowAll, boot, expectCleanLogs, expectToolCallsAnswered, messages, newSession, prompt, teardown } from "./allflags/helpers"

afterEach(teardown)

// A small fake window through the model policy: compaction at 90% of 8000 tokens = 7200.
const policy = (d: { config: string }) => {
  fs.mkdirSync(path.join(d.config, "ezkielyna", "ezk"), { recursive: true })
  fs.writeFileSync(
    path.join(d.config, "ezkielyna", "ezk", "model-policy.json"),
    JSON.stringify({ flash: [FLASH], chains: { light: [FLASH] }, models: { [FLASH]: { agentContext: 8_000 } } }),
  )
}
const script = (): Record<string, Step[]> => ({
  [FLASH]: [
    { ok: true, tool: { name: "read", args: { filePath: "README.md" } }, usage: { prompt: 7_600, completion: 50 } },
    { ok: true, text: "## Goal\nfinish the task\n## Open TODOs\n- write done.txt", usage: { prompt: 500, completion: 50 } },
    { ok: true, tool: { name: "write", args: { filePath: "done.txt", content: "done\n" } }, usage: { prompt: 900, completion: 20 } },
    { ok: true, text: "All done.", usage: { prompt: 1000, completion: 20 } },
    { ok: true, text: "extra", usage: { prompt: 1000, completion: 20 } },
  ],
})
const run = async (flags: string) => {
  const { gw, srv } = await boot({ flags: `${QUIET},${flags}`, mode: "acceptEdits", config: { ezk: { router: { policyURL: "" } } }, seed: policy, script: script() })
  const ses = await newSession(srv, { permission: allowAll(srv) })
  await prompt(srv, ses.id, "read README.md, then write done.txt", FLASH)
  await Bun.sleep(1500)
  return { gw, srv, ses, summaries: gw.requests.filter((r) => r.tools === 0) }
}

test("metadata ON + compaction recipe: 7600 reported tokens on an 8k window compacts, the task finishes", async () => {
  const { gw, srv, ses, summaries } = await run("+models.metadata,+compaction")
  expect(summaries.length).toBeGreaterThan(0)
  expect(summaries.every((r) => r.model === FLASH)).toBe(true)
  const msgs = await messages(srv, ses.id)
  expect(msgs.some((m) => m.parts?.some((p: any) => p.type === "compaction"))).toBe(true)
  expect(fs.existsSync(path.join(srv.dirs.project, "done.txt"))).toBe(true)
  // the session is not wedged: a following prompt is answered by a real model call
  const before = gw.requests.length
  await prompt(srv, ses.id, "anything else?", FLASH)
  expect(gw.requests.length).toBeGreaterThan(before)
  expectToolCallsAnswered(gw)
  expectCleanLogs(srv)
}, 200_000)

test("metadata ON, recipe flag OFF (default): the legacy trigger also compacts on the policy window", async () => {
  const { gw, srv, summaries } = await run("+models.metadata,-compaction")
  expect(summaries.length).toBeGreaterThan(0)
  expect(fs.existsSync(path.join(srv.dirs.project, "done.txt"))).toBe(true)
  expectToolCallsAnswered(gw)
  expectCleanLogs(srv)
}, 200_000)

// Note: the +compaction recipe reads agentContext from the policy itself (compaction.ts isOverflow), so it uses the policy window
// even with models.metadata OFF. Only the legacy path depends on the catalog window, which is what this test pins.
test("metadata OFF, recipe flag OFF: the policy window is not applied to the model (128k fallback), 7600 tokens do not compact", async () => {
  const { gw, summaries } = await run("-models.metadata,-models.vision,-compaction")
  expect(summaries.length).toBe(0)
  expect(gw.requests.every((r) => r.tools > 0)).toBe(true) // every call is a normal agent turn, none is a summary
}, 200_000)
