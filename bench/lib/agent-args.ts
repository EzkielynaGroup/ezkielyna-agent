// The CLI arguments the benchmark gives the agent for one task. Separate from run.ts so a test can pin them (review M13: the
// first version passed `--dangerously-skip-permissions` to `exec`, which does not have it, so every write was denied).
export type AgentMode = "exec" | "run"
/** Which agent runs the tasks: this fork, or upstream OpenCode (v1.19.3, the version the fork is based on). */
export type Agent = "ezkielyna" | "upstream"
export const AGENTS: Agent[] = ["ezkielyna", "upstream"]

/** Provider id in the generated upstream config; `--model` becomes `<UPSTREAM_PROVIDER>/<model>` on the upstream CLI. */
export const UPSTREAM_PROVIDER = "ezk-bench"
/** The agent-side variable the generated config reads the key from (`{env:...}`), never the key itself. */
export const UPSTREAM_KEY_ENV = "EZK_BENCH_UPSTREAM_KEY"

export function agentArgs(mode: AgentMode, ws: string, prompt: string, model?: string) {
  const modelArgs = model ? ["--model", model] : []
  // `exec` answers permission requests by --permission-mode, names the folder --cwd, and treats an untrusted folder as "ask"
  // (the workspace is trusted through EZK_TRUST_PROJECT=1, see agentEnv in run.ts).
  if (mode === "exec") return ["exec", "--json", "--permission-mode", "full", "--cwd", ws, ...modelArgs, prompt]
  return ["run", "--format", "json", "--dangerously-skip-permissions", "--dir", ws, ...modelArgs, prompt]
}

// Upstream v1.19.3 `opencode run` (packages/opencode/src/cli/cmd/run.ts at tag v1.19.3): --format default|json, --dir,
// --model provider/model, and the hidden --dangerously-skip-permissions (same effect as --auto). There is no exec command.
export function upstreamArgs(ws: string, prompt: string, model: string) {
  return agentArgs("run", ws, prompt, `${UPSTREAM_PROVIDER}/${model}`)
}

// The config upstream loads through OPENCODE_CONFIG (packages/opencode/src/config/config.ts at v1.19.3 merges it after the
// global config and before the project config). Shape checked against packages/core/src/v1/config/provider.ts and
// permission.ts at that tag. The key is a `{env:VAR}` template (packages/opencode/src/config/variable.ts substitutes it),
// so the file never holds the key. `@ai-sdk/openai-compatible` is in BUNDLED_PROVIDERS, so no npm install at run time.
export function upstreamConfig(baseURL: string, model: string) {
  return {
    permission: { "*": "allow" },
    provider: {
      [UPSTREAM_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ezkielyna gateway (bench upstream arm)",
        options: { baseURL, apiKey: `{env:${UPSTREAM_KEY_ENV}}` },
        models: { [model]: { name: model, tool_call: true } },
      },
    },
  }
}

// Env names from packages/core/src/flag/flag.ts and packages/opencode/src/effect/runtime-flags.ts at v1.19.3. Upstream has
// no telemetry switch: OpenTelemetry is opt-in through `experimental.openTelemetry`, which the generated config does not set.
// MODELS_FETCH is off because the VPS container may only reach the gateway.
export const UPSTREAM_ENV = {
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_PRUNE: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  NO_COLOR: "1",
}
