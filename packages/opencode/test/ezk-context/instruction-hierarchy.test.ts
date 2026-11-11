import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, configLayer],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })


const flagFile = { "ezkielyna.json": JSON.stringify({ ezk: { context: { hierarchy: true } } }) }

const untrusted = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.EZK_TRUST_PROJECT
      process.env.EZK_TRUST_PROJECT = "0"
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.EZK_TRUST_PROJECT
        else process.env.EZK_TRUST_PROJECT = prev
      }),
  )

describe("C1 instruction hierarchy through the Instruction service", () => {
  it.live("flag off: first match wins (unchanged behaviour)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* writeFiles(dir, { "AGENTS.md": "ROOT", "CLAUDE.md": "CLAUDE-ROOT" })
        const sys = yield* Instruction.Service.use((s) => s.system()).pipe(provideInstruction({ home: dir, config: dir }))
        expect(sys.join("\n")).toContain("ROOT")
        expect(sys.join("\n")).not.toContain("CLAUDE-ROOT")
      }),
    ),
  )

  it.live("flag on: AGENTS.md and CLAUDE.md both load, root first, comments stripped", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* writeFiles(dir, { ...flagFile, "AGENTS.md": "ROOT <!-- hidden -->", "CLAUDE.md": "CLAUDE-ROOT" })
        const sys = (yield* Instruction.Service.use((s) => s.system()).pipe(provideInstruction({ home: dir, config: dir }))).join("\n")
        expect(sys).toContain("ROOT")
        expect(sys).toContain("CLAUDE-ROOT")
        expect(sys).not.toContain("hidden")
        expect(sys.indexOf("ROOT")).toBeLessThan(sys.indexOf("CLAUDE-ROOT"))
      }),
    ),
  )

  it.live("flag on + untrusted folder: project files are skipped", () =>
    provideTmpdirInstance((dir) =>
      untrusted(
        Effect.gen(function* () {
          // user config dir is separate from the project: the user file stays, the project file is skipped
          yield* writeFiles(dir, { "cfg/ezkielyna.json": flagFile["ezkielyna.json"], "cfg/AGENTS.md": "USER-RULES", "AGENTS.md": "PROJECT-RULES" })
          const sys = (yield* Instruction.Service.use((s) => s.system()).pipe(provideInstruction({ home: dir, config: path.join(dir, "cfg") }))).join("\n")
          expect(sys).toContain("USER-RULES")
          expect(sys).not.toContain("PROJECT-RULES")
        }),
      ),
    ),
  )

  it.live("flag on: a path-scoped rule attaches when a matching file is read, once per message", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* writeFiles(dir, {
          ...flagFile,
          ".claude/rules/ts.md": "---\npaths: src/**/*.ts\n---\nTS-ONLY",
          "src/a.ts": "x",
          "docs/a.md": "x",
        })
        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const sys = (yield* svc.system()).join("\n")
          expect(sys).not.toContain("TS-ONLY")
          const id = MessageID.make("msg_message-rule-1")
          const hit = yield* svc.resolve([], path.join(dir, "src", "a.ts"), id)
          expect(hit.map((r) => r.content).join("\n")).toContain("TS-ONLY")
          expect(yield* svc.resolve([], path.join(dir, "src", "a.ts"), id)).toEqual([])
          expect(yield* svc.resolve([], path.join(dir, "docs", "a.md"), MessageID.make("msg_message-rule-2"))).toEqual([])
        }).pipe(provideInstruction({ home: dir, config: dir }))
      }),
    ),
  )
})
