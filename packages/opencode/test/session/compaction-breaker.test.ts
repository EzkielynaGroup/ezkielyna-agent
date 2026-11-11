// Review round 3 M-4: a tripped compaction breaker must stop AUTOMATIC compaction only; the loop skips the trigger and answers.
// The flag is read when the compaction service is built, so it is set before the layer exists (separate file, own process state).
import { afterAll, describe, expect } from "bun:test"
// Restored in afterAll: bun runs every test file in one process, and a leaked flag turned the compaction breaker on for
// session/compaction.test.ts (which runs next) in the full CI suite.
const previousFeatures = process.env.EZK_FEATURES
process.env.EZK_FEATURES = "compaction"
afterAll(() => {
  if (previousFeatures === undefined) delete process.env.EZK_FEATURES
  else process.env.EZK_FEATURES = previousFeatures
})

import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { ezkPaths } from "@opencode-ai/core/ezk/wipe"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session as SessionNs } from "@/session/session"
import { SessionCompaction } from "../../src/session/compaction"
import * as SessionProcessorModule from "../../src/session/processor"
import { SessionSummary } from "../../src/session/summary"
import { CompactionStateStore } from "../../src/ezk/compaction-state"
import { ProviderTest } from "../fake/provider"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const model = {
  id: "test-model", providerID: "test", name: "Test", limit: { context: 100_000, output: 32_000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: { toolcall: true, attachment: false, reasoning: false, temperature: true, input: { text: true, image: false, audio: false, video: false }, output: { text: true, image: false, audio: false, video: false } },
  api: { npm: "@ai-sdk/anthropic" }, options: {},
} as unknown as Provider.Model

const node = LayerNode.group([SessionCompaction.node, SessionNs.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node])
const it = testEffect(AppNodeBuilder.build(node, [
  [Provider.node, ProviderTest.fake({ model }).layer],
  [SessionProcessorModule.SessionProcessor.node, Layer.succeed(SessionProcessorModule.SessionProcessor.Service, SessionProcessorModule.SessionProcessor.Service.of({ create: () => Effect.die("unused") }))],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  [SessionSummary.node, Layer.succeed(SessionSummary.Service, SessionSummary.Service.of({ summarize: () => Effect.void, diff: () => Effect.succeed([]), computeDiff: () => Effect.succeed([]) }))],
]))

describe("compaction breaker pauses auto compaction only", () => {
  it.instance("autoPaused turns true once three ineffective attempts are recorded, and warns once", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const ssn = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const session = yield* ssn.create({})
      const errors: string[] = []
      const unsub = yield* events.listen((evt) => {
        if (evt.type === SessionNs.Event.Error.type) errors.push(JSON.stringify(evt.data))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      expect(yield* SessionCompaction.use.autoPaused(session.id)).toBe(false)
      const store = new CompactionStateStore(path.join(ezkPaths({ config: Global.Path.config, data: Global.Path.data }).ezkDataDir, "compaction-breaker.json"))
      for (let i = 0; i < 3; i++) store.record(session.id, { beforeTokens: 100, afterTokens: 95, ineffective: true })
      expect(yield* SessionCompaction.use.autoPaused(session.id)).toBe(true)
      expect(yield* SessionCompaction.use.autoPaused(session.id)).toBe(true)
      yield* Effect.sleep("30 millis")
      expect(errors.filter((e) => e.includes("still answered"))).toHaveLength(1)
    }),
  )
})
