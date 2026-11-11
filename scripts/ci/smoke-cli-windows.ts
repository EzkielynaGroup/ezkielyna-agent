#!/usr/bin/env bun
// Deep Windows CLI smoke. Runs only on a Windows Actions runner and uses an isolated profile plus
// loopback model/search mocks. The only credential is a fixed, disposable test string.
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { safeEnv } from "./safe-env"

const binary = process.argv[2] ? path.resolve(process.argv[2]) : undefined
if (process.platform !== "win32") {
  console.error("smoke-cli-windows.ts must run on a Windows runner")
  process.exit(2)
}
if (!binary || !(await Bun.file(binary).exists())) {
  console.error("usage: bun scripts/ci/smoke-cli-windows.ts <path to ezkielyna.exe>")
  process.exit(2)
}

const TEST_KEY = "ci-only-mock-key-never-valid"
const MODEL = "deepseek-v4.1-flash"
const failures: string[] = []
const projectName = "ezk windows smoke project"
const temp = await mkdtemp(path.join(tmpdir(), "ezk-windows-cli-"))
const home = path.join(temp, "home")
const project = path.join(temp, projectName)
const pidFile = path.join(project, "child.pid")
const editedFile = path.join(project, "windows-smoke.txt")
const protectedFile = path.join(project, ".git", "config")
await mkdir(path.dirname(protectedFile), { recursive: true })
await mkdir(home, { recursive: true })
await mkdir(project, { recursive: true })
const flagsDir = path.join(home, ".config", "ezkielyna")
await mkdir(flagsDir, { recursive: true })
await writeFile(path.join(flagsDir, "ezkielyna.json"), JSON.stringify({ ezk: { router: { policyURL: "" } } }))
await writeFile(protectedFile, "smoke-safe-config\n")
const protectedHash = hash(await readFile(protectedFile))
const calls: string[] = []
const executedTools: string[] = []
const searchAuth: string[] = []
const modelAuth: string[] = []
let turn = 0
type ToolCall = { name: string; args: Record<string, unknown> }
let depthActions: ToolCall[] | undefined
let depthTranscript = ""
let shellPrompt = ""
// "Started in the background." is part of the tool result the model reads, not of the `exec --json` events, so the mock records it.
let backgroundNote = false

const mock = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: MODEL, object: "model" }] })
    }
    if (url.pathname === "/api/pricing") {
      return Response.json({ success: true, group_ratio: { default: 1 }, data: [] })
    }
    if (url.pathname === "/v1/search" && req.method === "POST") {
      searchAuth.push(req.headers.get("authorization") ?? "")
      const body = (await req.json()) as { query?: string }
      return Response.json({
        cached: false,
        results: [{ title: "Windows mock result", url: "https://example.invalid/windows", snippet: body.query ?? "mock" }],
      })
    }
    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST")
      return new Response("not found", { status: 404 })
    modelAuth.push(req.headers.get("authorization") ?? "")
    const body = (await req.json()) as {
      messages?: unknown[]
      tools?: { function?: { name?: string; description?: string } }[]
      stream?: boolean
    }
    const tools = (body.tools ?? []).flatMap((item) => item.function?.name ?? [])
    calls.push(tools.join(","))
    // Turn 4 stops the background PowerShell process. A cold PowerShell can take several seconds to start on a CI
    // runner, so give it time to write its PID first; otherwise exec_stop wins the race and no PID is ever written.
    if (!depthActions && turn === 4) {
      const until = Date.now() + 30_000
      while (Date.now() < until && !(await Bun.file(pidFile).text().catch(() => "")).trim()) await Bun.sleep(250)
    }
    if (depthActions) {
      depthTranscript += JSON.stringify(body.messages ?? [])
      shellPrompt = body.tools?.find((tool) => tool.function?.name === "bash")?.function?.description ?? shellPrompt
    }
    const next = depthActions ? depthActions[turn++] : windowsTool(turn++, body.messages ?? [])
    if (!next) return body.stream === false ? jsonText("Windows integration smoke completed") : streamText("Windows integration smoke completed")
    executedTools.push(next.name)
    return body.stream === false ? jsonTool(next) : streamTool(next)
  },
})

const baseEnv = safeEnv(process.env)
const isolatedEnv: Record<string, string> = {
  ...baseEnv,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: path.join(temp, "local-app-data"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  OPENCODE_CONFIG_DIR: flagsDir,
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  OPENCODE_TEST_HOME: home,
  // continue_loop_on_deny: the first planned write is a deliberate protected-path probe (.git/config). exec denies it in every mode, and a
  // denied permission ends the agent loop unless this is set, which would leave the rest of the plan (edit, shell, background, search) untested.
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ shell: "cmd.exe", formatter: false, lsp: false, experimental: { continue_loop_on_deny: true } }),
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_PURE: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_AUTOCOMPACT: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_AUTH_CONTENT: "{}",
  EZK_FEATURES: "+exec",
  NO_COLOR: "1",
}

async function main() {
  const version = await run(binary!, ["--version"], isolatedEnv, home)
  requirePass(version.code === 0 && (version.out + version.err).trim().length > 0, "ezkielyna --version prints a version", detail(version))
  const help = await run(binary!, ["--help"], isolatedEnv, home)
  const helpText = help.out + help.err
  requirePass(help.code === 0, "ezkielyna --help exits successfully", detail(help))
  requirePass(!/opencode/i.test(helpText), "CLI help contains no OpenCode branding", tail(helpText))

  const doctorEnv: Record<string, string> = { ...isolatedEnv, OPENCODE_AUTH_CONTENT: "{}", EZKIELYNA_BASE_URL: "http://127.0.0.1:1/v1" }
  delete doctorEnv.EZKIELYNA_API_KEY
  const doctor = await run(binary!, ["doctor"], doctorEnv, home)
  const doctorText = doctor.out + doctor.err
  requirePass(doctor.code === 1, "doctor reports a missing key with a failing exit code", detail(doctor))
  requirePass(/not found|tidak ada/i.test(doctorText), "doctor gives a clear no-key message", tail(doctorText))
  requirePass(!doctorText.includes(TEST_KEY), "doctor never prints a key")

  // `--permission-mode full` only applies in a trusted folder: in any other folder exec answers every request with "deny" (and logs
  // "not a trusted folder"), whatever the mode. A real user runs `ezkielyna trust` once per project, so the smoke does the same.
  const trust = await run(binary!, ["trust", project], isolatedEnv, home)
  requirePass(trust.code === 0, "ezkielyna trust marks the project folder as trusted", detail(trust))
  const trustStatus = await run(binary!, ["trust", "--status", project], isolatedEnv, home)
  requirePass(trustStatus.code === 0, "ezkielyna trust --status reports the project folder as trusted", detail(trustStatus))

  const execEnv = {
    ...isolatedEnv,
    EZKIELYNA_API_KEY: TEST_KEY,
    EZKIELYNA_BASE_URL: "http://127.0.0.1:" + mock.port + "/v1",
  }
  const task = await run(
    binary!,
    ["exec", "--json", "--permission-mode", "full", "--max-turns", "10", "--cwd", project, "--model", "ezkielyna/" + MODEL, "Exercise edit, protected path, cmd quoting, background stop, and web search."],
    execEnv,
    project,
    180_000,
  )
  const events = task.out + task.err
  const items = parseEvents(task.out).flatMap((event) => (event.type === "item.completed" && event.item ? [event.item] : []))
  const protectedProbe = items.find((item) => item.type === "file_change" && (item.changes ?? []).some((change: { path: string }) => samePath(change.path, protectedFile)))
  const shellItem = items.find((item) => item.type === "command_execution" && String(item.command).includes("windows-shell-ok"))
  const stopItem = items.find((item) => item.type === "mcp_tool_call" && item.tool === "exec_stop")
  const searchItem = items.find((item) => item.type === "mcp_tool_call" && item.tool === "web_search")
  requirePass(!events.includes("not a trusted folder"), "the project folder is trusted, so --permission-mode full is honoured", tail(task.err))
  requirePass(task.code === 3, "exec --json refuses the protected .git/config write (exit 3)", detail(task))
  requirePass(protectedProbe?.status === "failed", "the .git\\config write is reported as a failed file_change for exactly the planned path", JSON.stringify(protectedProbe))
  requirePass(hash(await readFile(protectedFile)) === protectedHash, "protected .git/config remains unchanged")
  requirePass((await Bun.file(editedFile).text().catch(() => "")) === "windows-smoke-edit-ok\n", "mock task edits a file under a project path containing spaces")
  requirePass(shellItem?.status === "completed" && shellItem.exit_code === 0 && String(shellItem.aggregated_output).includes("windows-shell-ok"), "PowerShell command survives cmd.exe quoting", JSON.stringify(shellItem))
  requirePass(backgroundNote, "exec starts a background process", "the tool result the model saw has no 'Started in the background.'")
  requirePass(stopItem?.status === "completed" && JSON.stringify(stopItem.result).includes("Stopped"), "exec_stop reports the background process stopped", JSON.stringify(stopItem))
  requirePass(searchItem?.status === "completed" && JSON.stringify(searchItem.result).includes("Windows mock result"), "web_search returns the loopback mock result", JSON.stringify(searchItem))
  requirePass(events.includes("turn.completed") && events.includes("Windows integration smoke completed"), "mock-backed exec turn completes", tail(events))
  requirePass(searchAuth.includes("Bearer " + TEST_KEY), "web_search uses only the disposable mock credential")
  requirePass(modelAuth.length > 0 && modelAuth.every((value) => value === "Bearer " + TEST_KEY), "model requests use only the disposable mock credential")
  requirePass(calls.some((names) => names.split(",").includes("web_search")), "web_search is offered to the mock model")
  requirePass(JSON.stringify(executedTools) === JSON.stringify(["write", "write", "bash", "bash", "exec_stop", "web_search"]), "mock task exercised each planned tool", JSON.stringify(executedTools))
  requirePass(turn >= 7, "mock gateway observed all planned tool calls and a final response", "turns=" + turn)

  const pidText = await Bun.file(pidFile).text().catch(() => "")
  const pid = Number(pidText.trim())
  requirePass(Number.isSafeInteger(pid) && pid > 0, "background PowerShell process wrote its PID", pidText)
  if (Number.isSafeInteger(pid) && pid > 0) {
    const deadline = Date.now() + 15_000
    let alive = true
    while (Date.now() < deadline) {
      const check = await run("tasklist.exe", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], safeEnv(process.env), temp, 10_000)
      alive = check.out.includes('"' + pid + '"')
      if (!alive) break
      await Bun.sleep(500)
    }
    requirePass(!alive, "exec_stop tree-kills the background PowerShell process", "pid=" + pid)
  }
}

async function mainDepth(scenario: string) {
  const depthProject = scenario === "paths" ? deepProjectPath(temp) : path.join(temp, "line endings project")
  await mkdir(depthProject, { recursive: true })
  const trust = await run(binary!, ["trust", depthProject], isolatedEnv, home)
  requirePass(trust.code === 0, "trusted isolated Windows fixture project", detail(trust))

  const environment: Record<string, string> = {
    ...isolatedEnv,
    EZKIELYNA_API_KEY: TEST_KEY,
    EZKIELYNA_BASE_URL: "http://127.0.0.1:" + mock.port + "/v1",
    // No shell key: this smoke must exercise the Windows default shell selection.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false, experimental: { continue_loop_on_deny: true } }),
  }
  delete environment.SHELL
  turn = 0
  depthTranscript = ""
  shellPrompt = ""
  depthActions = []

  const crlfFile = path.join(depthProject, "windows-crlf.txt")
  const lfFile = path.join(depthProject, "windows-lf.txt")
  const deepFile = path.join(depthProject, "deep fixture.txt")

  if (scenario === "line-endings") {
    await writeFile(crlfFile, "first\r\nreplace-me\r\nlast\r\n")
    await writeFile(lfFile, "first\nreplace-me\nlast\n")
    const git = async (args: string[]) => run("git", ["-C", depthProject, ...args], safeEnv(process.env), depthProject)
    requirePass((await git(["init", "-q"])).code === 0, "initialize a local-only diff fixture")
    await git(["config", "core.autocrlf", "false"])
    await git(["config", "user.name", "Windows smoke"])
    await git(["config", "user.email", "windows-smoke@invalid.example"])
    await git(["add", "windows-crlf.txt", "windows-lf.txt"])
    requirePass((await git(["commit", "-q", "-m", "baseline"])).code === 0, "record the two original line-ending fixtures")
    depthActions = [
      { name: "read", args: { filePath: crlfFile } },
      { name: "read", args: { filePath: lfFile } },
      { name: "edit", args: { filePath: crlfFile, oldString: "replace-me", newString: "changed-crlf" } },
      { name: "edit", args: { filePath: lfFile, oldString: "replace-me", newString: "changed-lf" } },
    ]
  } else if (scenario === "paths") {
    await writeFile(deepFile, "deep-path-marker\nreplace-me\n")
    depthActions = [
      { name: "read", args: { filePath: deepFile } },
      { name: "edit", args: { filePath: deepFile, oldString: "replace-me", newString: "deep-path-edited" } },
      { name: "bash", args: { command: "dir", description: "List the long project path", workdir: depthProject, tty: false } },
    ]
  } else if (scenario === "default-shell") {
    depthActions = [
      {
        name: "bash",
        args: {
          command: '$env:EZK_WIN_DEPTH = "quoted value"; Write-Output "quoted $env:EZK_WIN_DEPTH" && Write-Output \'chain-ok\'',
          description: "Check Windows default shell quoting and chaining",
          workdir: depthProject,
          tty: false,
        },
      },
    ]
  } else {
    requirePass(false, `unknown Windows smoke scenario: ${scenario}`)
    return
  }

  const task = await run(
    binary!,
    ["exec", "--json", "--permission-mode", "full", "--max-turns", "8", "--cwd", depthProject, "--model", "ezkielyna/" + MODEL, "Exercise this Windows smoke scenario exactly as requested."],
    environment,
    depthProject,
    180_000,
  )
  const events = parseEvents(task.out).flatMap((event) => (event.type === "item.completed" && event.item ? [event.item] : []))
  requirePass(task.code === 0 && turn >= depthActions.length + 1, `the ${scenario} mock-backed CLI task completes`, detail(task))

  if (scenario === "line-endings") {
    const crlf = (await readFile(crlfFile)).toString("utf8")
    const lf = (await readFile(lfFile)).toString("utf8")
    const diff = await run("git", ["-C", depthProject, "-c", "core.autocrlf=false", "diff", "--unified=0", "--", "windows-crlf.txt", "windows-lf.txt"], safeEnv(process.env), depthProject)
    const changed = diff.out.split(/\r?\n/).filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
    const names = await run("git", ["-C", depthProject, "diff", "--name-only"], safeEnv(process.env), depthProject)
    requirePass(crlf.includes("\r\n") && !/(?<!\r)\n/.test(crlf), "edit keeps CRLF endings throughout the CRLF file")
    requirePass(lf.includes("\n") && !lf.includes("\r"), "edit keeps LF endings throughout the LF file")
    requirePass(JSON.stringify(changed) === JSON.stringify(["-replace-me", "+changed-crlf", "-replace-me", "+changed-lf"]), "git diff contains only the intended line replacements", diff.out)
    requirePass(JSON.stringify(names.out.trim().split(/\r?\n/).filter(Boolean).sort()) === JSON.stringify(["windows-crlf.txt", "windows-lf.txt"]), "git diff names only the two edited fixtures", names.out)
  }

  if (scenario === "paths") {
    const contents = await Bun.file(deepFile).text()
    const shellItem = events.find((item) => item.type === "command_execution" && String(item.command).trim() === "dir")
    requirePass(depthProject.includes("proyek uji ñ") && depthProject.length > 200 && depthProject.length < 250, "project path contains spaces/non-ASCII and exceeds 200 characters", `${depthProject.length}: ${depthProject}`)
    requirePass(depthTranscript.includes("deep-path-marker"), "read returns file content from the deep non-ASCII path")
    requirePass(contents.includes("deep-path-edited"), "edit changes a file in the deep non-ASCII path")
    requirePass(shellItem?.status === "completed" && shellItem.exit_code === 0 && String(shellItem.aggregated_output).includes("deep fixture.txt"), "exec dir lists the deep project path", JSON.stringify(shellItem))
  }

  if (scenario === "default-shell") {
    const shellItem = events.find((item) => item.type === "command_execution" && String(item.command).includes("EZK_WIN_DEPTH"))
    const name = shellPrompt.match(/^# ((?:Windows )?PowerShell(?: \(7\+\)| \(5\.1\))?) shell notes/im)?.[1]
    const instructions = shellPrompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" | ")
    console.log(`INFO shell instructions delivered to model: ${instructions || "not identified"}`)
    requirePass(Boolean(name) && !/cmd\.exe/i.test(shellPrompt), "model-facing shell instructions identify PowerShell as the default")
    const output = String(shellItem?.aggregated_output ?? "")
    const works = shellItem?.status === "completed" && shellItem.exit_code === 0 && output.includes("quoted quoted value") && output.includes("chain-ok")
    const clearUnsupportedChain = /PowerShell \(5\.1\)/i.test(shellPrompt) && /avoid.*&&.*because.*does not support it/i.test(shellPrompt) && /&&|Unexpected token/i.test(output)
    requirePass(Boolean(works || clearUnsupportedChain), "quoted $env: command with && works or returns the documented PowerShell 5.1 parser error", JSON.stringify(shellItem))
  }

  depthActions = undefined
}

try {
  const scenario = process.argv[3]
  if (scenario) await mainDepth(scenario)
  else await main()
} finally {
  const pid = Number((await Bun.file(pidFile).text().catch(() => "")).trim())
  if (Number.isSafeInteger(pid) && pid > 0) {
    await Bun.spawn(["taskkill.exe", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
  }
  mock.stop(true)
  await rm(temp, { recursive: true, force: true }).catch(() => {})
}
if (failures.length) process.exit(1)
console.log("Windows CLI deep smoke passed")

function windowsTool(index: number, messages: unknown[]) {
  const common = "cmd/PowerShell Windows integration smoke"
  switch (index) {
    case 0:
      // Deliberate, not a path bug: the first planned tool is a write into .git/config, which exec must refuse in every mode. The path
      // is exactly path.join(project, ".git", "config"), so the failed file_change must name this very file.
      return { name: "write", args: { filePath: path.join(project, ".git", "config"), content: "must not overwrite" } }
    case 1:
      return { name: "write", args: { filePath: editedFile, content: "windows-smoke-edit-ok\n" } }
    case 2:
      return { name: "bash", args: { command: 'powershell.exe -NoProfile -Command "Write-Output \'windows-shell-ok\'"', description: common, workdir: project, tty: false } }
    case 3:
      return { name: "bash", args: { command: 'powershell.exe -NoProfile -Command "$PID | Set-Content -NoNewline child.pid; Start-Sleep -Seconds 120"', description: common, workdir: project, run_in_background: true, tty: false } }
    case 4: {
      const transcript = JSON.stringify(messages)
      backgroundNote = transcript.includes("Started in the background")
      const id = transcript.match(/session_id[^a-z0-9_]*(bg_[a-z0-9_-]+)/i)?.[1] ?? "bg_1"
      return { name: "exec_stop", args: { session_id: id } }
    }
    case 5:
      return { name: "web_search", args: { query: "windows-ci-smoke" } }
    default:
      return undefined
  }
}

function streamTool(tool: { name: string; args: Record<string, unknown> }) {
  const call = { id: "call_" + turn, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }
  const payload = [
    { id: "chatcmpl-windows-smoke", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    {
      id: "chatcmpl-windows-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
    },
    { id: "chatcmpl-windows-smoke", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "chatcmpl-windows-smoke", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
  ]
  return new Response(payload.map((item) => "data: " + JSON.stringify(item) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

function jsonTool(tool: { name: string; args: Record<string, unknown> }) {
  return Response.json({
    id: "chatcmpl-windows-smoke",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "call_" + turn, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  })
}

function streamText(text: string) {
  const chunks = [
    { id: "chatcmpl-windows-final", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "chatcmpl-windows-final", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "chatcmpl-windows-final", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
  ]
  return new Response(chunks.map((item) => "data: " + JSON.stringify(item) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

function jsonText(text: string) {
  return Response.json({
    id: "chatcmpl-windows-final",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  })
}

async function run(command: string, args: string[], env: Record<string, string | undefined>, cwd: string, timeout = 90_000) {
  const proc = Bun.spawn([command, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
  const timer = setTimeout(() => proc.kill(), timeout)
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { out, err, code }
}

function parseEvents(text: string) {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("{")) return []
    try {
      return [JSON.parse(line) as { type: string; item?: any }]
    } catch {
      return []
    }
  })
}

function samePath(left: string, right: string) {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
}

function deepProjectPath(root: string) {
  let project = path.join(root, "proyek uji ñ")
  for (let index = 0; project.length <= 215 && index < 8; index++) {
    project = path.join(project, `level-${index}-${"x".repeat(16)}`)
  }
  return project
}

function hash(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function requirePass(ok: boolean, label: string, evidence = "") {
  if (ok) {
    console.log("PASS " + label)
    return
  }
  console.error("FAIL " + label + (evidence ? "\n" + evidence : ""))
  failures.push(label)
}

function detail(result: { code: number; out: string; err: string }) {
  return "exit=" + result.code + "\n" + tail(result.out + result.err)
}

function tail(text: string) {
  return text.slice(-4000)
}
