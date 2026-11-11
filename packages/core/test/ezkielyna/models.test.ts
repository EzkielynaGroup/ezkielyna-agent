import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EZK } from "../../src/ezkielyna-brand"
import { ASK_FIRST_PERMISSION, askFirstPermission, catalogProvider, configDefaults, isChatModel, listModels, pickDefaultModel, pickSmallModel, SAFE_BASH, withEzkielyna } from "../../src/ezkielyna"
import { DEFAULT_POLICY, mergePolicy } from "../../src/ezk/model-policy"

const reply = (ids: string[], status = 200) =>
  (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status })) as unknown as typeof fetch
const down = (async () => {
  throw new Error("offline")
}) as unknown as typeof fetch
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ezk-models-"))

describe("model discovery", () => {
  test("filters non-chat models and keeps the gateway order", async () => {
    const r = await listModels({ key: "sk-test", cacheDir: tmp(), fetch: reply(["default-model", "bge-m3", "edge-tts", "voyage-4", "qwen3-embedding-0.6b", "minimax-m3.1-flash"]) })
    expect(r).toMatchObject({ ids: ["default-model", "minimax-m3.1-flash"], source: "remote", reachable: true, status: 200 })
  })

  test("shares one in-flight model-list request with health checks", async () => {
    const dir = tmp()
    let calls = 0
    const fetcher = (async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ data: [{ id: "auto" }] }), { status: 200 })
    }) as unknown as typeof fetch
    const [catalog, health] = await Promise.all([
      listModels({ key: "sk-beta-shared-1", cacheDir: dir, fetch: fetcher, share: true }),
      listModels({ key: "sk-beta-shared-1", cacheDir: dir, fetch: fetcher, share: true }),
    ])
    expect(calls).toBe(1)
    expect(catalog).toBe(health)
  })

  test("Auto is the default: auto, then default-model, then Flash-plan models", () => {
    expect(pickDefaultModel(["auto", "hy3"])).toBe("auto")
    expect(pickDefaultModel(["balanced-model", "default-model", "fast-model", "minimax-m3.1-flash"])).toBe("default-model")
    expect(pickDefaultModel(["deepseek-v4.1-flash", "minimax-m3.1-flash", "mimo-v2.6-flash"])).toBe("minimax-m3.1-flash")
    expect(pickDefaultModel(["mimo-v2.6-flash"])).toBe("mimo-v2.6-flash")
    expect(pickDefaultModel(["zzz", "aaa"])).toBe("zzz")
    expect(pickDefaultModel([])).toBeUndefined()
  })

  test("small tasks use the cheapest alias", () => {
    expect(pickSmallModel(["default-model", "fast-model"])).toBe("fast-model")
    expect(pickSmallModel(["default-model"])).toBe("default-model")
  })

  test("offline: last good list for the same key, then static fallback, never throws", async () => {
    const dir = tmp()
    await listModels({ key: "sk-a", cacheDir: dir, fetch: reply(["x-model"]) })
    expect((await listModels({ key: "sk-a", cacheDir: dir, fetch: down })).source).toBe("cache")
    expect((await listModels({ key: "sk-b", cacheDir: dir, fetch: down })).source).toBe("fallback")
    expect((await listModels({ cacheDir: dir })).source).toBe("fallback")
    expect((await listModels({ key: "sk-c", cacheDir: dir, fetch: reply([], 403) })).source).toBe("fallback")
  })

  test("the cache never stores the key", async () => {
    const dir = tmp()
    await listModels({ key: "sk-" + "supersecretkey1234567890", cacheDir: dir, fetch: reply(["x"]) })
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), "utf8")).not.toContain("supersecret")
  })

  test("upstream-hosted providers are removed from the catalog and ours is added", () => {
    expect(Object.keys(withEzkielyna({ opencode: {}, "opencode-go": {}, openai: {} })).sort()).toEqual(["ezkielyna", "openai"])
  })

  test("non-chat id patterns", () => {
    for (const id of ["bge-m3", "edge-tts", "voyage-rerank-3", "gpt-image-2", "seedance-2"]) expect(isChatModel(id)).toBe(false)
    for (const id of ["auto", "default-model", "glm-5.3-flash", "kimi-k2.7-code"]) expect(isChatModel(id)).toBe(true)
  })

  test("auto aliases are named Auto in the catalog", () => {
    expect(EZK.autoModels["default-model"]).toBe("Auto")
  })

  test("picker catalog applies policy context and vision metadata only to capable models", () => {
    const policy = mergePolicy(DEFAULT_POLICY, {
      models: {
        "deepseek-v4.1-flash": { agentContext: 262_144, maxOutput: 384_000, vision: true, reasoning: true, effort: false },
        "deepseek-v4.1-flash-1017": { agentContext: 262_144, maxOutput: 128_000, vision: true, reasoning: true, effort: true },
        "minimax-m3.1-flash": { vision: false },
      },
    })
    const catalog = catalogProvider(
      ["deepseek-v4.1-flash", "deepseek-v4.1-flash-1017", "minimax-m3.1-flash"],
      policy.models,
    )
    expect(catalog.models["deepseek-v4.1-flash"]).toMatchObject({
      limit: { context: 262_144, input: 262_144, output: 384_000 },
      attachment: true,
      modalities: { input: ["text", "image", "pdf"] },
      reasoning: true,
      reasoning_options: [{ type: "toggle" }],
    })
    expect(catalog.models["deepseek-v4.1-flash-1017"]).toMatchObject({
      limit: { context: 262_144, input: 262_144, output: 128_000 },
      attachment: true,
      modalities: { input: ["text", "image", "pdf"] },
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    })
    expect(catalog.models["minimax-m3.1-flash"]).toMatchObject({
      attachment: false,
      modalities: { input: ["text"] },
      limit: { context: 128_000 },
    })
  })
})

describe("config defaults (privacy) and ask-first permissions", () => {
  const cfg = configDefaults()
  const ask = ASK_FIRST_PERMISSION
  test("no share, notify-only updates, no OpenCode Zen", () => {
    expect(cfg.share).toBe("disabled")
    expect(cfg.autoupdate).toBe("notify")
    expect(cfg.disabled_providers).toEqual(["opencode", "opencode-go"])
  })
  test("edits, web fetches and shell commands ask first", () => {
    expect(ASK_FIRST_PERMISSION.edit).toBe("ask")
    expect(ASK_FIRST_PERMISSION.webfetch).toBe("ask")
    expect(ASK_FIRST_PERMISSION.bash["*"]).toBe("ask")
  })
  test("git read commands skip the prompt only in trusted projects (a planted .git/config can run programs)", () => {
    expect(Object.keys(askFirstPermission(true).bash)).toContain("git status")
    const untrusted = Object.keys(askFirstPermission(false).bash)
    expect(untrusted).toContain("ls")
    expect(untrusted.filter((c) => c.startsWith("git"))).toEqual([])
  })
  test("shell allow-list is exact strings only (a wildcard would also match `> file`)", () => {
    for (const cmd of SAFE_BASH) expect(cmd).not.toContain("*")
    for (const dangerous of ["rm", "curl", "sh", "bash", "python3", "node", "find", "sed", "awk", "xargs", "tee", "cat", "echo"]) expect(Object.keys(ASK_FIRST_PERMISSION.bash)).not.toContain(dangerous)
  })
})
