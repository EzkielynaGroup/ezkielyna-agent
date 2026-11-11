// Review H4: unified exec (+exec) must run commands inside the OS sandbox when it applies (+sandbox), like the legacy path.
import { afterAll, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, type Schema } from "effect"
import type * as Scope from "effect/Scope"
import path from "path"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import fs from "node:fs"
import os from "node:os"
import { sandboxFor } from "@opencode-ai/core/ezk/sandbox"
import { execManager } from "@opencode-ai/core/ezk/exec/manager"
import { alive } from "@opencode-ai/core/ezk/exec/process-tree"
import { ShellTool } from "../../src/tool/shell"
import { ShellPrompt } from "../../src/tool/shell/prompt"
import { ExecListTool, ExecStopTool, WriteStdinTool } from "../../src/ezk/exec/run"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import type { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"

const posix = process.platform !== "win32"
const previous = process.env.EZK_FEATURES
process.env.EZK_FEATURES = "+exec,+sandbox"
afterAll(() => {
  execManager().stopAll()
  if (previous === undefined) delete process.env.EZK_FEATURES
  else process.env.EZK_FEATURES = previous
})

const layer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Plugin.node, Truncate.node, Config.node, Agent.node, RuntimeFlags.node]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(layer)
const projectRoot = path.join(__dirname, "../..")

const ctx = (session = "ses_exec_a"): Tool.Context => ({
  sessionID: SessionID.make(session),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const init = <P extends Schema.Decoder<unknown>, M extends Record<string, unknown>, E, R>(tool: Effect.Effect<Tool.Info<P, M>, E, R>) =>
  Effect.gen(function* () {
    const info = yield* tool
    return yield* info.init()
  })

const inProject = <A, E, R>(self: Effect.Effect<A, E, R | Scope.Scope>) => self.pipe(provideInstance(projectRoot))


const sandboxAvailable = posix && sandboxFor("true", "ask", projectRoot, { env: { EZK_FEATURES: "+sandbox" } }).wrap !== null

describe.skipIf(!sandboxAvailable)("unified exec runs sandboxed (+exec +sandbox)", () => {
  const outside = path.join(os.homedir(), `.ezk-exec-sbx-${process.pid}-${Date.now()}`)
  afterAll(() => fs.rmSync(outside, { recursive: true, force: true }))

  it.live("a write outside the project is blocked, a write in the temp folder works, and the result says so", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        expect(bash.description).toContain("OS sandbox")
        const blocked = yield* bash.execute({ command: `echo x > "${outside}"; echo done`, yield_time_ms: 5_000, tty: false }, ctx())
        expect(fs.existsSync(outside)).toBe(false)
        expect(blocked.metadata.sandbox).toBeDefined()
        expect(blocked.output).toMatch(/not permitted|denied|Read-only|<sandbox>/i)
        const tmp = path.join(os.tmpdir(), `ezk-exec-sbx-ok-${process.pid}`)
        const ok = yield* bash.execute({ command: `echo fine > "${tmp}" && cat "${tmp}"; rm -f "${tmp}"`, yield_time_ms: 5_000, tty: false }, ctx())
        expect(ok.output).toContain("fine")
        expect(ok.metadata.exit).toBe(0)
      }),
    ),
  )

  it.live("a background command is sandboxed too", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        const started = yield* bash.execute({ command: `sh -c 'echo y > "${outside}.bg" 2>/dev/null; echo finished'`, run_in_background: true, tty: false }, ctx())
        yield* Effect.promise(() => Bun.sleep(1_200))
        expect(fs.existsSync(`${outside}.bg`)).toBe(false)
        expect(started.metadata.sandbox).toBeDefined()
      }),
    ),
  )

  it.live("the default PTY backend is sandboxed too", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        const blocked = yield* bash.execute({ command: `echo x > "${outside}.pty"; echo after`, yield_time_ms: 5_000 }, ctx())
        expect(fs.existsSync(`${outside}.pty`)).toBe(false)
        expect(blocked.output).toContain("after")
        expect(blocked.metadata.sandbox).toBeDefined()
      }),
    ),
  )
})
