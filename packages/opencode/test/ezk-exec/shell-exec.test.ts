// T2 unified exec through the real bash tool (flag on): a dev-server-style command kept alive across tool calls,
// interactive stdin, list/stop, owner isolation, and the flag-off bytes of the bash tool.
import { afterAll, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, type Schema } from "effect"
import type * as Scope from "effect/Scope"
import path from "path"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { execManager } from "@opencode-ai/core/ezk/exec/manager"
import { alive } from "@opencode-ai/core/ezk/exec/process-tree"
import { ShellTool } from "../../src/tool/shell"
import { ShellPrompt } from "../../src/tool/shell/prompt"
import { ExecListTool, ExecStopTool, WriteStdinTool, stdinAsk } from "../../src/ezk/exec/run"
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
process.env.EZK_FEATURES = "+exec"
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

describe.skipIf(!posix)("unified exec through the bash tool", () => {
  it.live("dev server keeps running across tool calls; write_stdin polls; exec_stop kills it", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        const poll = yield* init(WriteStdinTool)
        const list = yield* init(ExecListTool)
        const stop = yield* init(ExecStopTool)
        const started = yield* bash.execute(
          { command: "echo 'Local: http://localhost:5173'; while true; do sleep 0.2; echo 'hmr update'; done", run_in_background: true, tty: false },
          ctx(),
        )
        const id = started.metadata.session_id as string
        expect(started.metadata.running).toBe(true)
        expect(started.output).toContain(`session_id: ${id}`)
        expect(started.output).toContain("Started in the background.")

        // another "turn" later: still alive, new output only
        yield* Effect.promise(() => Bun.sleep(500))
        const next = yield* poll.execute({ session_id: id, yield_time_ms: 300 }, ctx())
        expect(next.output).toContain("hmr update")
        expect(next.output).toContain("Still running")
        const pid = execManager().get(id)!.pid
        expect(alive(pid)).toBe(true)

        const listed = yield* list.execute({}, ctx())
        expect(listed.output).toContain(id)
        expect(listed.output).toContain("running")

        const stopped = yield* stop.execute({ session_id: id }, ctx())
        expect(stopped.output).toContain("Stopped")
        yield* Effect.promise(async () => {
          for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50)
        })
        expect(alive(pid)).toBe(false)
      }),
    ),
  )

  it.live("a foreground command that outlives yield_time_ms returns a session_id instead of being killed", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        const poll = yield* init(WriteStdinTool)
        const first = yield* bash.execute({ command: "echo begin; sleep 1.2; echo end", yield_time_ms: 300, tty: false }, ctx())
        expect(first.metadata.running).toBe(true)
        expect(first.metadata.exit).toBeNull()
        expect(first.output).toContain("begin")
        const done = yield* poll.execute({ session_id: first.metadata.session_id as string, yield_time_ms: 5_000 }, ctx())
        expect(done.output).toContain("end")
        expect(done.output).toContain("Process exited with code 0.")
        expect(done.metadata.exit).toBe(0)
      }),
    ),
  )

  it.live("interactive prompt answered through write_stdin (PTY)", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        const poll = yield* init(WriteStdinTool)
        const asked = yield* bash.execute({ command: 'printf "Project name? "; read n; echo "created $n"', yield_time_ms: 500 }, ctx())
        expect(asked.output).toContain("Project name?")
        const answered = yield* poll.execute({ session_id: asked.metadata.session_id as string, chars: "demo\n", yield_time_ms: 3_000 }, ctx())
        expect(answered.output).toContain("created demo")
        expect(answered.metadata.exit).toBe(0)
      }),
    ),
  )

  it.live("short commands behave like before: output and exit code in one call", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        const r = yield* bash.execute({ command: "echo hello; exit 4" }, ctx())
        expect(r.metadata.exit).toBe(4)
        expect(r.metadata.running).toBe(false)
        expect(r.output).toContain("hello")
        expect(r.output).toContain("Process exited with code 4.")
      }),
    ),
  )

  it.live("another session cannot read or stop the process", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        const poll = yield* init(WriteStdinTool)
        const r = yield* bash.execute({ command: "sleep 5", run_in_background: true, tty: false }, ctx("ses_owner"))
        const id = r.metadata.session_id as string
        const exit = yield* poll.execute({ session_id: id }, ctx("ses_intruder")).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        execManager().stop(id)
      }),
    ),
  )

  test("write_stdin asks like bash: protected paths and git writes are forced, and 'always' is never offered", () => {
    const info = { command: "python3", cwd: projectRoot }
    for (const chars of ["open('.git/hooks/pre-commit','w').write('x')\n", "import os; os.system('git commit -am x')\n", "echo x > .github/workflows/ci.yml\n", "git config core.hooksPath /tmp\n"]) {
      const req = stdinAsk(info, chars, projectRoot)
      expect(req.forceAsk).toBe(true)
      expect(req.always).toEqual([])
    }
    const plain = stdinAsk(info, "print(1+1)\n", projectRoot)
    expect(plain.forceAsk).toBe(false)
    expect(plain.always).toEqual([])
    expect(stdinAsk(info, ".git/config\n", projectRoot, false).forceAsk).toBe(false) // flag safety.protectedPaths off
  })

  it.live("write_stdin: typed input mentioning .git/hooks reaches ctx.ask with forceAsk and no 'always' (python REPL allowed earlier)", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        const poll = yield* init(WriteStdinTool)
        const r = yield* bash.execute({ command: "cat", run_in_background: true, tty: false }, ctx("ses_stdin"))
        const id = r.metadata.session_id as string
        const asks: any[] = []
        const spy = { ...ctx("ses_stdin"), ask: (input: any) => (asks.push(input), Effect.void) }
        yield* poll.execute({ session_id: id, chars: "echo pwned > .git/hooks/pre-commit\n", yield_time_ms: 300 }, spy as Tool.Context)
        yield* poll.execute({ session_id: id, chars: "hello\n", yield_time_ms: 300 }, spy as Tool.Context)
        execManager().stop(id)
        expect(asks).toHaveLength(2)
        expect(asks[0]).toMatchObject({ permission: "bash", always: [], forceAsk: true })
        expect(asks[1]).toMatchObject({ always: [], forceAsk: false })
      }),
    ),
  )

  it.live("flag on: bash advertises the exec fields and notes", () =>
    inProject(
      Effect.gen(function* () {
        const bash = yield* init(ShellTool)
        const schema = ToolJsonSchema.fromSchema(bash.parameters as any) as { properties: Record<string, unknown> }
        expect(Object.keys(schema.properties).sort()).toEqual(["command", "monitor", "run_in_background", "timeout", "tty", "workdir", "yield_time_ms"])
        expect(bash.description).toContain("Long-running commands (unified exec)")
      }),
    ),
  )
})

describe("flag off", () => {
  it.live("bash prompt bytes are exactly the pre-exec ones", () =>
    Effect.sync(() => {
      const limits = { maxLines: 2000, maxBytes: 51200 }
      const off = ShellPrompt.render("bash", "linux", limits, 120_000)
      const explicitOff = ShellPrompt.render("bash", "linux", limits, 120_000, false)
      expect(explicitOff.description).toBe(off.description)
      expect(off.description).not.toContain("unified exec")
      const schema = ToolJsonSchema.fromSchema(off.parameters as any) as { properties: Record<string, unknown> }
      expect(Object.keys(schema.properties).sort()).toEqual(["command", "timeout", "workdir"])
      expect(JSON.stringify(ToolJsonSchema.fromSchema(off.parameters as any))).toBe(JSON.stringify(ToolJsonSchema.fromSchema(ShellPrompt.Parameters as any)))
    }),
  )
})
