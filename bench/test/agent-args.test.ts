import { describe, expect, test } from "bun:test"
import { UPSTREAM_ENV, UPSTREAM_KEY_ENV, agentArgs, upstreamArgs, upstreamConfig } from "../lib/agent-args"

describe("benchmark agent arguments (review M13)", () => {
  test("exec: explicit permission mode and --cwd, never the run-only skip flag", () => {
    const args = agentArgs("exec", "/ws", "do it", "ezkielyna/flash")
    expect(args.slice(0, 2)).toEqual(["exec", "--json"])
    expect(args).toContain("--permission-mode")
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("full")
    expect(args[args.indexOf("--cwd") + 1]).toBe("/ws")
    expect(args).not.toContain("--dangerously-skip-permissions")
    expect(args).not.toContain("--dir")
    expect(args.at(-1)).toBe("do it")
    expect(args[args.indexOf("--model") + 1]).toBe("ezkielyna/flash")
  })
  test("run keeps its own flags", () => {
    const args = agentArgs("run", "/ws", "do it")
    expect(args).toEqual(["run", "--format", "json", "--dangerously-skip-permissions", "--dir", "/ws", "do it"])
  })
})

describe("upstream arm (OpenCode v1.19.3)", () => {
  test("argument shape is upstream's `opencode run`: --format json, --dir, --model provider/model, no exec", () => {
    const args = upstreamArgs("/ws", "do it", "deepseek-v4.1-flash")
    expect(args.slice(0, 3)).toEqual(["run", "--format", "json"])
    expect(args[args.indexOf("--dir") + 1]).toBe("/ws")
    expect(args[args.indexOf("--model") + 1]).toBe("ezk-bench/deepseek-v4.1-flash")
    expect(args).not.toContain("--json")
    expect(args).not.toContain("--permission-mode")
    expect(args).not.toContain("--cwd")
    expect(args.at(-1)).toBe("do it")
  })

  test("generated config: openai-compatible provider at the gateway, key as an env template, every permission allowed", () => {
    const config = upstreamConfig("https://gateway.example/v1", "deepseek-v4.1-flash")
    expect(config.permission).toEqual({ "*": "allow" })
    const provider = config.provider["ezk-bench"]!
    expect(provider.npm).toBe("@ai-sdk/openai-compatible")
    expect(provider.options.baseURL).toBe("https://gateway.example/v1")
    expect(provider.options.apiKey).toBe("{env:EZK_BENCH_UPSTREAM_KEY}")
    expect(Object.keys(provider.models)).toEqual(["deepseek-v4.1-flash"])
    expect(provider.models["deepseek-v4.1-flash"]!.tool_call).toBe(true)
  })

  test("the serialized config holds no secret-looking value, only the {env:...} template", () => {
    const text = JSON.stringify(upstreamConfig("https://gateway.example/v1", "m"))
    expect(text).toContain(`{env:${UPSTREAM_KEY_ENV}}`)
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/)
    expect(text).not.toContain("bench-dry-run-not-a-key")
  })

  test("agent env disables update checks, models.dev fetches and project config; no EZK_* variable", () => {
    expect(UPSTREAM_ENV.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
    expect(UPSTREAM_ENV.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(UPSTREAM_ENV.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
    expect(Object.keys(UPSTREAM_ENV).filter((name) => name.startsWith("EZK_"))).toEqual([])
  })
})
