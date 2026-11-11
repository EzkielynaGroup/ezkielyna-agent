// Review M6: the sandbox follows the session's real permission mode (not only the EZK_PERMISSION_MODE stub), and M14: the
// sandbox may write the agent's spill/log/tmp folders, not its whole data dir.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { sandboxFor } from "@opencode-ai/core/ezk/sandbox"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EzkSandbox } from "@/ezk/sandbox"
import { resetFlagsCache, setMode } from "@/ezk/safety"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Plugin.node, Truncate.node, Config.node, Agent.node, RuntimeFlags.node])),
    testInstanceStoreLayer,
  ),
)

const saved = { features: process.env.EZK_FEATURES, mode: process.env.EZK_PERMISSION_MODE }
beforeAll(() => {
  process.env.EZK_FEATURES = "+modes"
  delete process.env.EZK_PERMISSION_MODE
  resetFlagsCache()
})
afterAll(() => {
  if (saved.features === undefined) delete process.env.EZK_FEATURES
  else process.env.EZK_FEATURES = saved.features
  if (saved.mode === undefined) delete process.env.EZK_PERMISSION_MODE
  else process.env.EZK_PERMISSION_MODE = saved.mode
  resetFlagsCache()
})

const available = process.platform !== "win32" && sandboxFor("true", "ask", "/tmp", { env: { EZK_FEATURES: "+sandbox" } }).wrap !== null
const ctx = (session: string) => ({
  sessionID: SessionID.make(session),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe.skipIf(!available)("sandbox follows the session's permission mode", () => {
  test("with the modes on, the tool schema carries the sandbox text (new sessions start in Edit otomatis)", () => {
    expect(EzkSandbox.active()).toBe(true)
    expect(EzkSandbox.active({ EZK_FEATURES: "+modes,-sandbox" })).toBe(false)
    expect(EzkSandbox.active({ EZK_FEATURES: "+modes", EZK_PERMISSION_MODE: "full" })).toBe(false)
    expect(EzkSandbox.active({ EZK_FEATURES: "" })).toBe(false)
  })

  it.live("Tanya dulu and Rencana run unsandboxed, Edit otomatis / Otomatis-aman sandboxed, Penuh never", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      return yield* Effect.gen(function* () {
        const wrap = (session: string) =>
          EzkSandbox.plan(ctx(session), { command: "echo hi" }, { cwd: dir, root: dir, shell: "/bin/bash" }).pipe(Effect.map((plan) => plan.wrap))
        setMode("ses_ask", "ask")
        setMode("ses_accept", "acceptEdits")
        setMode("ses_safe", "safeAuto")
        setMode("ses_plan", "plan")
        setMode("ses_full", "full")
        expect(yield* wrap("ses_ask")).toBeNull()
        expect(yield* wrap("ses_plan")).toBeNull()
        expect(yield* wrap("ses_full")).toBeNull()
        expect(yield* wrap("ses_accept")).not.toBeNull()
        expect(yield* wrap("ses_safe")).not.toBeNull()
      }).pipe(provideInstance(dir))
    }),
  )

  it.live("only the spill, log and tmp folders of the data dir are writable, never the data dir itself", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      return yield* Effect.gen(function* () {
        setMode("ses_w", "acceptEdits")
        const plan = yield* EzkSandbox.plan(ctx("ses_w"), { command: "true" }, { cwd: dir, root: dir, shell: "/bin/bash" })
        expect(plan.writable).not.toContain(Global.Path.data)
        for (const root of plan.writable) expect(root === Global.Path.data).toBe(false)
        const allowed = ["tool-output", "log", "tmp"].map((name) => path.join(Global.Path.data, name))
        for (const root of plan.writable) if (root.startsWith(Global.Path.data + path.sep)) expect(allowed).toContain(root)
      }).pipe(provideInstance(dir))
    }),
  )

  it.live("escalation approvals never offer 'always' for risky prefixes (review M8)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      return yield* Effect.gen(function* () {
        setMode("ses_esc", "acceptEdits")
        const asked: { always: string[]; patterns: string[] }[] = []
        const base = ctx("ses_esc")
        const spy = { ...base, ask: (req: any) => Effect.sync(() => void asked.push({ always: req.always, patterns: req.patterns })) }
        const plan = (command: string, escalation: "require_escalated" | "with_network") =>
          EzkSandbox.plan(spy as any, { command, sandbox_permissions: escalation, justification: "needed" }, { cwd: dir, root: dir, shell: "/bin/bash" })
        yield* plan("python3 -c 'print(1)'", "require_escalated")
        yield* plan("bash -c 'curl x'", "require_escalated")
        yield* plan("npm install left-pad", "with_network")
        expect(asked.map((a) => a.always)).toEqual([[], [], ["with_network:npm install *"]])
        expect(asked[0]!.patterns).toEqual(["require_escalated:python3 -c 'print(1)'"]) // the single approval is still offered
      }).pipe(provideInstance(dir))
    }),
  )
})
