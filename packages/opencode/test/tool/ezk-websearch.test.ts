import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Truncate } from "@/tool/truncate"
import { EzkWebSearchTool } from "@/tool/ezk-websearch"
import { MessageID, SessionID } from "@/session/schema"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".ezkielyna")])),
})
const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Truncate.node]), [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

const KEYS = ["EZKIELYNA_API_KEY", "EZK_FEATURES", "EZKIELYNA_BASE_URL"] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const setEnv = (env: Partial<Record<(typeof KEYS)[number], string | undefined>>) => {
  for (const k of KEYS) {
    const v = k in env ? env[k] : undefined
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  await disposeAllInstances()
})

const listTools = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const agent = yield* Agent.Service
  const build = yield* agent.get("build")
  if (!build) throw new Error("build agent not found")
  return yield* registry.tools({ providerID: ProviderV2.ID.opencode, modelID: ModelV2.ID.make("test"), agent: build })
})
const snapshot = (tools: { id: string; description: string; jsonSchema?: unknown }[]) =>
  JSON.stringify(tools.map((t) => [t.id, t.description, t.jsonSchema]))

describe("ezk web_search registry gating", () => {
  it.instance("key present + flag on: web_search offered, upstream websearch hidden", () =>
    Effect.gen(function* () {
      setEnv({ EZKIELYNA_API_KEY: "k-test" })
      // fresh instance state is created lazily on first use, after the env is set
      const ids = (yield* listTools).map((t) => t.id)
      expect(ids).toContain("web_search")
      expect(ids).not.toContain("websearch")
    }),
  )

  it.instance("no key: tool absent and list identical to the upstream list", () =>
    Effect.gen(function* () {
      setEnv({})
      const ids = (yield* listTools).map((t) => t.id)
      expect(ids).not.toContain("web_search")
    }),
  )
})

describe("ezk web_search flag-off fingerprint", () => {
  // Both runs use the same upstream gating (provider "opencode" shows upstream websearch), so equal bytes prove no drift.
  it.instance("flag off + key: tool list bytes are those of the no-key baseline", () =>
    Effect.gen(function* () {
      setEnv({})
      const baseline = snapshot(yield* listTools)
      yield* Effect.promise(() => disposeAllInstances())
      setEnv({ EZKIELYNA_API_KEY: "k-test", EZK_FEATURES: "-websearch" })
      const off = snapshot(yield* listTools)
      expect(off).toBe(baseline)
      expect(off).toContain('"websearch"')
      expect(off).not.toContain('"web_search"')
    }),
  )
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("ezk web_search tool execution (mock server)", () => {
  const run = (handler: (req: Request) => Response | Promise<Response>, asks: unknown[] = []) =>
    Effect.acquireUseRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: handler })),
      (server) =>
        Effect.gen(function* () {
          setEnv({ EZKIELYNA_API_KEY: "k-test", EZKIELYNA_BASE_URL: `http://127.0.0.1:${server.port}/v1` })
          const info = yield* EzkWebSearchTool
          const tool = yield* info.init()
          return yield* tool.execute({ query: "bun runtime" }, { ...ctx, ask: (r: unknown) => Effect.sync(() => void asks.push(r)) } as any)
        }),
      (server) => Effect.sync(() => server.stop(true)),
    )

  it.instance("success: asks permission web_search with always *, formats list", () =>
    Effect.gen(function* () {
      const asks: any[] = []
      let auth = ""
      const out = yield* run((req) => {
        auth = req.headers.get("authorization") ?? ""
        return Response.json({ query: "bun runtime", results: [{ title: "Bun", url: "https://bun.sh", snippet: "fast" }], cached: false, took_ms: 5 })
      }, asks)
      expect(out.output).toBe("1. Bun — https://bun.sh\n   fast\n\nuse webfetch on a URL to read the page")
      expect(auth).toBe("Bearer k-test")
      expect(asks[0]).toMatchObject({ permission: "web_search", always: ["*"] })
    }),
  )

  it.instance("401, 429, 502 and empty results map to plain messages", () =>
    Effect.gen(function* () {
      const err = (status: number) => () => Response.json({ error: { message: "x", type: "t" } }, { status })
      expect((yield* run(err(401))).output).toContain("API key was not accepted")
      expect((yield* run(err(429))).output).toContain("Stop searching")
      expect((yield* run(err(502))).output).toContain("temporarily unavailable")
      expect((yield* run(() => Response.json({ query: "q", results: [], cached: false, took_ms: 1 }))).output).toContain("No results")
    }),
  )
})
