#!/usr/bin/env bun
// Stand-in for upstream `opencode` in bench tests (test/upstream-dry-run.test.ts). It behaves like `opencode run --format
// json` as far as the bench can observe: reads the generated config from OPENCODE_CONFIG, takes the key from the
// {env:VAR} template, calls <baseURL>/chat/completions (non-streaming) with the bare model id, runs the one bash tool call
// the mock scripts, and prints upstream-shaped events ({type, timestamp, sessionID, part}). It never prints the key.
// Anything that would be wrong for the real upstream binary is reported as an `error` event so the test fails on it.
const argv = process.argv.slice(2)
if (argv.includes("--version")) {
  console.log("1.19.3-stub")
  process.exit(0)
}

const sessionID = "ses_stub"
const emit = (type: string, data: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + "\n")
const fail = (message: string) => {
  emit("error", { error: { name: "StubError", data: { message } } })
  process.exit(1)
}

if (argv.slice(0, 3).join(" ") !== "run --format json") fail(`not invoked as run --format json: ${argv.join(" ")}`)
const dir = argv[argv.indexOf("--dir") + 1]
const qualified = argv[argv.indexOf("--model") + 1]
const prompt = argv.at(-1)!
if (!argv.includes("--dir") || !dir || !argv.includes("--model") || !qualified) fail("missing --dir or --model")
if (!argv.includes("--dangerously-skip-permissions") && !argv.includes("--auto")) fail("permissions would be asked")
const ezk = Object.keys(process.env).filter((name) => name.startsWith("EZK_") && name !== "EZK_BENCH_UPSTREAM_KEY")
if (ezk.length) fail(`Ezkielyna-only variables in the upstream env: ${ezk.join(", ")}`)
if (process.env.OPENCODE_DISABLE_AUTOUPDATE !== "1" || process.env.OPENCODE_DISABLE_MODELS_FETCH !== "1")
  fail("update check or models.dev fetch not disabled")

const configPath = process.env.OPENCODE_CONFIG
if (!configPath) fail("OPENCODE_CONFIG is not set")
if (!configPath!.startsWith(process.env.HOME ?? "\0")) fail(`config is not under HOME: ${configPath}`)
if (configPath!.startsWith(dir!)) fail("config was written into the workspace")
const configText = await Bun.file(configPath!).text()
const config = JSON.parse(configText) as {
  permission?: unknown
  provider?: Record<string, { npm?: string; options?: { baseURL?: string; apiKey?: string } }>
}
const [providerID, ...rest] = qualified!.split("/")
const model = rest.join("/")
const provider = config.provider?.[providerID!]
if (!provider) fail(`provider ${providerID} not in config`)
if (provider!.npm !== "@ai-sdk/openai-compatible") fail(`provider npm ${provider!.npm} is not bundled upstream`)
const template = provider!.options?.apiKey ?? ""
const keyEnv = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(template)?.[1]
if (!keyEnv) fail(`apiKey is not an {env:VAR} template: ${template}`)
const key = process.env[keyEnv!]
if (!key) fail(`${keyEnv} is empty in the agent env`)
if (configText.includes(key!)) fail("the key value is written in the config file")
if (JSON.stringify(config.permission) !== JSON.stringify({ "*": "allow" })) fail("permission is not {\"*\": \"allow\"}")
const baseURL = provider!.options?.baseURL
if (!baseURL) fail("no baseURL")

const messages: Record<string, unknown>[] = [{ role: "user", content: prompt }]
const texts: string[] = []
for (let step = 0; step < 4; step++) {
  emit("step_start", { part: { type: "step-start" } })
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, stream: false, messages, tools: [{ type: "function", function: { name: "bash" } }] }),
  })
  if (!response.ok) fail(`gateway answered ${response.status}`)
  const body = (await response.json()) as {
    model: string
    choices: { message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]
    usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }
  }
  emit("bench_stub", { requested: model, served: body.model, baseURL, config: configPath, keyEnv, authorized: true })
  const cached = body.usage.prompt_tokens_details?.cached_tokens ?? 0
  const message = body.choices[0]!.message
  const call = message.tool_calls?.[0]
  if (call) {
    const command = String((JSON.parse(call.function.arguments) as { command?: string }).command ?? "")
    const proc = Bun.spawn(["bash", "-c", command], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    const output = await new Response(proc.stdout).text()
    const code = await proc.exited
    emit("tool_use", {
      part: { type: "tool", tool: call.function.name, state: { status: code === 0 ? "completed" : "error", output, error: code === 0 ? undefined : `exit ${code}` } },
    })
    messages.push({ role: "assistant", content: null, tool_calls: message.tool_calls }, { role: "tool", tool_call_id: call.id, content: output.slice(0, 2000) })
  }
  emit("step_finish", {
    part: {
      type: "step-finish",
      cost: 0,
      tokens: { input: body.usage.prompt_tokens - cached, output: body.usage.completion_tokens, reasoning: 0, cache: { read: cached, write: 0 } },
    },
  })
  if (call) continue
  texts.push(message.content ?? "")
  emit("text", { part: { type: "text", text: message.content ?? "", time: { start: 0, end: 1 } } })
  break
}
if (!texts.length) fail("no final text after 4 steps")
