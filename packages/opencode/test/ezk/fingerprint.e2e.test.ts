// Gate: with the ezk features off, the bytes sent to the model (system prompt + tool schemas) are identical to the
// build without them; router on (user picked a concrete model) must not change them either.
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
let srv: Server | undefined
let gw: ReturnType<typeof startMockGateway> | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
})

async function capture(features: string | undefined) {
  gw = startMockGateway({ models: { [KEY]: ["deepseek-v4.1-flash", "minimax-m3.1-flash", "deepseek-v4-pro-0813"] } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: features === undefined ? {} : { EZK_FEATURES: features } })
  const s = await newSession(srv)
  await prompt(srv, s.id, "say hi", "deepseek-v4.1-flash")
  const req = gw.requests[0]!
  // normalise the temp project/home path, which differs per run
  const norm = (v: unknown) => JSON.stringify(v).split(srv!.dir).join("<TMP>")
  const system = norm(req.body.messages.filter((m: any) => m.role === "system"))
  const tools = norm(req.body.tools)
  const result = { system, tools, hash: createHash("sha256").update(system + tools).digest("hex") }
  await srv.stop()
  gw.stop()
  srv = gw = undefined
  return result
}

test("router on, concrete model pinned: prompt bytes identical to all-features-off", async () => {
  const waveAOff = [
    "-tools.boundedOutput",
    "-tools.applyPatchEverywhere",
    "-tools.editRecovery",
    "-tools.editFixer",
    "-safety.protectedPaths",
    "-safety.scrubEnv",
    "-brand.hygiene",
    "-models.metadata",
    "-models.vision",
  ].join(",")
  const off = await capture(`-router,-memory,-search,${waveAOff}`)
  const on = await capture(`-memory,-search,${waveAOff}`)
  expect(on.system).toBe(off.system)
  expect(on.tools).toBe(off.tools)
  expect(on.hash).toBe(off.hash)
}, 120_000)
