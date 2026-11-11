// The shell tool with the Ezkielyna sandbox (EZK_FEATURES=+sandbox): schema, denial note and escalation approvals.
// The runs use real bubblewrap and are skipped where it cannot start.
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findBwrap } from "@opencode-ai/core/ezk/sandbox"
import { Config } from "@/config/config"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EzkSandbox } from "@/ezk/sandbox"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

type Request = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">
const context = (requests: Request[]) => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (req: Request) => Effect.sync(() => void requests.push(req)),
})

const available = process.platform === "linux" && Boolean(findBwrap().path)
// Runs that need a working bwrap; reported as skipped elsewhere.
const withBwrap: typeof it.live = available
  ? it.live
  : (((name: string) => test.skip(name, () => {})) as unknown as typeof it.live)
const outside = fs.mkdtempSync(path.join(os.homedir(), ".ezk-sbx-shell-"))
const saved = { features: process.env.EZK_FEATURES, mode: process.env.EZK_PERMISSION_MODE, shell: process.env.SHELL }
beforeAll(() => {
  process.env.EZK_FEATURES = "+sandbox"
  delete process.env.EZK_PERMISSION_MODE
  process.env.SHELL = "/bin/bash"
})
afterAll(() => {
  for (const [key, value] of [
    ["EZK_FEATURES", saved.features],
    ["EZK_PERMISSION_MODE", saved.mode],
    ["SHELL", saved.shell],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(outside, { recursive: true, force: true })
})

const run = (
  args: { command: string; sandbox_permissions?: string; justification?: string },
  requests: Request[] = [],
) =>
  Effect.gen(function* () {
    const tool = yield* (yield* ShellTool).init()
    return yield* tool.execute(args as { command: string }, context(requests))
  })

describe("shell tool + sandbox", () => {
  it.live("schema and description gain the escalation fields only when the sandbox is on", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const tool = yield* Effect.gen(function* () {
        return yield* (yield* ShellTool).init()
      }).pipe(provideInstance(tmp))
      const fields = (tool.parameters as unknown as { fields: Record<string, unknown> }).fields
      expect(Object.keys(fields)).toEqual(["command", "timeout", "workdir", "sandbox_permissions", "justification"])
      expect(tool.description).toContain("Commands run in an OS sandbox")

      process.env.EZK_FEATURES = ""
      const plain = yield* Effect.gen(function* () {
        return yield* (yield* ShellTool).init()
      }).pipe(provideInstance(tmp))
      process.env.EZK_FEATURES = "+sandbox"
      expect(Object.keys((plain.parameters as unknown as { fields: Record<string, unknown> }).fields)).toEqual([
        "command",
        "timeout",
        "workdir",
      ])
      expect(plain.description).not.toContain("Sandbox:")
      expect(EzkSandbox.active({ EZK_FEATURES: "+sandbox", EZK_PERMISSION_MODE: "full" })).toBe(false)
    }),
  )

  withBwrap("a write outside the project is blocked and explained in plain words", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const result = yield* run({ command: `echo x > ${outside}/blocked.txt` }).pipe(provideInstance(tmp))
      expect(result.metadata.exit).not.toBe(0)
      expect(result.metadata).toMatchObject({ sandbox: "bwrap", network: false })
      expect(result.output).toContain("Read-only file system")
      expect(result.output).toContain("<sandbox>")
      expect(result.output).toContain('sandbox_permissions "require_escalated"')
      expect(fs.existsSync(path.join(outside, "blocked.txt"))).toBe(false)
    }),
  )

  withBwrap("inside the project the command runs normally, sandboxed", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const result = yield* run({ command: "echo hello > a.txt && cat a.txt" }).pipe(provideInstance(tmp))
      expect(result.metadata).toMatchObject({ exit: 0, sandbox: "bwrap" })
      expect(result.output).toContain("hello")
      expect(result.output).not.toContain("<sandbox>")
    }),
  )

  withBwrap("require_escalated asks the user once (always = this prefix) and runs outside the sandbox", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const requests: Request[] = []
      const result = yield* run(
        {
          command: `echo y > ${outside}/allowed.txt`,
          sandbox_permissions: "require_escalated",
          justification: "Write the report to the shared folder",
        },
        requests,
      ).pipe(provideInstance(tmp))
      const escalation = requests.find((req) => req.permission === EzkSandbox.ESCALATION_PERMISSION)
      expect(escalation?.patterns).toEqual([`require_escalated:echo y > ${outside}/allowed.txt`])
      expect(escalation?.always).toEqual(["require_escalated:echo *"])
      expect(escalation?.metadata).toMatchObject({
        escalation: "require_escalated",
        justification: "Write the report to the shared folder",
      })
      expect(result.metadata.exit).toBe(0)
      expect(result.metadata).not.toHaveProperty("sandbox")
      expect(fs.readFileSync(path.join(outside, "allowed.txt"), "utf8")).toBe("y\n")
    }),
  )

  withBwrap("the network is blocked, with_network asks and allows it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hi") })
      const probe = `exec 3<>/dev/tcp/127.0.0.1/${server.port} && echo connected`
      const blocked = yield* run({ command: probe }).pipe(provideInstance(tmp))
      expect(blocked.output).toContain("<sandbox>")
      expect(blocked.output).toContain('"with_network"')
      const requests: Request[] = []
      const allowed = yield* run(
        { command: probe, sandbox_permissions: "with_network", justification: "Check the dev server" },
        requests,
      ).pipe(provideInstance(tmp))
      server.stop(true)
      expect(requests.map((req) => req.permission)).toContain(EzkSandbox.ESCALATION_PERMISSION)
      expect(allowed.metadata).toMatchObject({ sandbox: "bwrap", network: true })
      expect(allowed.output).toContain("connected")
    }),
  )
})
