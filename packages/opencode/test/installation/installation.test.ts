import { describe, expect, test } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

// A handler that returns undefined never responds.
function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response | undefined) {
  const client = HttpClient.make((request) => {
    const response = handler(request)
    return response ? Effect.succeed(HttpClientResponse.fromWeb(request, response)) : Effect.never
  })
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response | undefined,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

const it = testEffect(testLayer(() => new Response("{}", { status: 404 })))

describe("installation (Ezkielyna Agent)", () => {
  describe("isUpdate", () => {
    test("only strictly newer valid versions count", () => {
      expect(Installation.isUpdate("1.19.0", "1.19.1")).toBe(true)
      expect(Installation.isUpdate("1.19.3-ezk.1", "1.19.3-ezk.2")).toBe(true)
      expect(Installation.isUpdate("1.19.0", "1.19.0")).toBe(false)
      expect(Installation.isUpdate("1.19.0", "1.18.35")).toBe(false)
      expect(Installation.isUpdate("1.19.0", "not-a-version")).toBe(false)
      expect(Installation.isUpdate("local", "1.19.0")).toBe(true)
    })
  })

  describe("identity", () => {
    test("User-Agent carries our product name, never opencode", () => {
      expect(Installation.userAgent("cli")).toMatch(/^ezkielyna-agent\//)
      expect(Installation.USER_AGENT.toLowerCase()).not.toContain("opencode")
    })
  })

  it.effect("method is always the signed installer and spawns no package-manager probes", () =>
    Effect.gen(function* () {
      const method = yield* Installation.Service.use((s) => s.method())
      expect(method).toBe("curl")
    }),
  )

  it.effect("without an update server, latest is the installed version and upgrade explains where to download", () =>
    Effect.gen(function* () {
      const svc = yield* Installation.Service
      expect(yield* svc.latest()).toBe(InstallationVersion)
      const exit = yield* Effect.exit(svc.upgrade("curl", "9.9.9"))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("ezkielyna.store")
    }),
  )
})
