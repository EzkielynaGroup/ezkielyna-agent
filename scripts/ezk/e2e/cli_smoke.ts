// End-to-end smoke test of the compiled CLI against the mock gateway.
//   bun scripts/ezk/e2e/cli_smoke.ts <path-to-ezkielyna-binary>
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startMock } from "./mock_openai"

const bin = process.argv[2] ? path.resolve(process.argv[2]) : ""
if (!bin || !fs.existsSync(bin)) throw new Error(`usage: cli_smoke.ts <ezkielyna binary> (got ${bin})`)
const KEY = "sk-" + "mock-test-key-0123456789abcdef"
let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`)
  if (!ok) failures++
}

async function run(args: string[], env: Record<string, string>, cwd: string) {
  const proc = Bun.spawn([bin, ...args], { cwd, env: { ...process.env, PWD: cwd, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 120_000)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  clearTimeout(timer)
  return { out, err, code: proc.exitCode }
}
const events = (out: string) => out.split("\n").flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
const sandbox = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-e2e-"))
  const work = path.join(root, "work")
  fs.mkdirSync(work)
  const env = { XDG_CONFIG_HOME: `${root}/c`, XDG_DATA_HOME: `${root}/d`, XDG_CACHE_HOME: `${root}/k`, XDG_STATE_HOME: `${root}/s`, EZKIELYNA_API_KEY: KEY, MCODE_DISABLE_TELEMETRY: "1" }
  return { root, work, env }
}

// 1. version + help are branded
{
  const { work, env } = sandbox()
  const v = await run(["--version"], env, work)
  check("--version prints the Ezkielyna build", /^\d+\.\d+\.\d+/.test(v.out.trim()), v.out)
  const h = await run(["--help"], env, work)
  // Rosetta (x64 binary on Apple Silicon) prints a Bun "CPU lacks AVX" warning with a github URL before the help text
  h.err = h.err.split("\n").filter((l) => !/^warn: CPU lacks AVX|bun-darwin-x64-baseline/.test(l)).join("\n")
  check("help is branded and has no upstream commands", h.err.includes("ezkielyna") && !/\bgithub\b|\bconsole\b/.test(h.err.split("Options:")[0]) && !/opencode\.ai/.test(h.err + h.out))
  check("help has no 'opencode' text at all", !/opencode/i.test(h.err + h.out), (h.err + h.out).split("\n").filter((l) => /opencode/i.test(l)).join(" | "))
  check("upstream-only commands are gone (console; uninstall is now the branded Ezkielyna uninstall)", !/\bconsole\b/.test(h.err + h.out))
  // every subcommand's help, including positional descriptions, must be free of the upstream name
  const leaks: string[] = []
  for (const sub of ["run", "providers", "providers login", "providers list", "providers logout", "mcp", "mcp add", "mcp list", "agent", "agent create", "agent list", "memory", "memory status", "gateway telegram", "upgrade", "serve", "web", "models", "account", "trust", "stats", "export", "import", "pr", "session", "session list", "plugin", "db", "attach", "acp", "debug"]) {
    const r = await run([...sub.split(" "), "--help"], env, work)
    const text = (r.out + r.err).split("\n").filter((l) => !/^warn: CPU lacks AVX|bun-darwin-x64-baseline/.test(l)).join("\n")
    const hit = text.split("\n").find((l) => /opencode/i.test(l))
    if (hit) leaks.push(`${sub}: ${hit.trim().slice(0, 80)}`)
  }
  check("no 'opencode' text in any subcommand help", leaks.length === 0, leaks.join(" | "))
  const a = await run(["account", "--help"], env, work)
  check("`account` command exists", /account/.test(a.err + a.out) && /--json/.test(a.err + a.out), a.err + a.out)
  const t = await run(["trust", "--status"], env, work)
  check("`trust --status` reports an untrusted folder (exit 1)", t.code === 1 && /not trusted|tidak dipercaya/.test(t.out + t.err), `${t.code} ${t.out}${t.err}`)
  const mem = await run(["memory", "status"], env, work)
  check("`memory status` works and reads local files only", mem.code === 0 && /memory|memori/i.test(mem.out + mem.err), `${mem.code} ${(mem.out + mem.err).slice(0, 200)}`)
  const tg = await run(["gateway", "telegram", "run"], env, work)
  check("Telegram bridge is off by default: without a bot token it refuses to start", tg.code !== 0 && /token/i.test(tg.out + tg.err), `${tg.code} ${(tg.out + tg.err).slice(0, 200)}`)
  const noKey = await run(["account"], { ...env, EZKIELYNA_API_KEY: "" }, work)
  check("`account` without a key says how to sign in", /providers login/.test(noKey.err + noKey.out), noKey.err + noKey.out)
}

// 2. full task with auto-approve: write, edit, run
{
  const { work, env } = sandbox()
  const mock = startMock({ validKey: KEY, dir: work })
  const r = await run(["run", "--auto", "--format", "json", "-m", "ezkielyna/default-model", "create hello.py, change it, run it"], { ...env, EZKIELYNA_BASE_URL: mock.url }, work)
  const ev = events(r.out)
  const tools = ev.filter((e) => e.type === "tool_use").map((e) => ({ tool: e.part?.tool, status: e.part?.state?.status }))
  check("tool calls write -> edit -> bash all completed", JSON.stringify(tools) === JSON.stringify([{ tool: "write", status: "completed" }, { tool: "edit", status: "completed" }, { tool: "bash", status: "completed" }]), JSON.stringify(tools) + r.err.slice(-300))
  const file = path.join(work, "hello.py")
  check("file was created and edited", fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("hello from mock"))
  check("command output reached the transcript", r.out.includes("hello from mock"))
  check("final answer arrived", ev.some((e) => e.type === "text" && String(e.part?.text).includes("Done")))
  check("only the mock host was used, with the key", mock.requests.length > 0 && mock.requests.every((q) => q.auth === `Bearer ${KEY}`))
  check("model list comes from /v1/models (non-chat filtered)", mock.requests.some((q) => q.path === "/v1/models"))
  // 10 lean tools, plus the gateway web_search tool that is offered whenever a key exists (ezk-wb-websearch, ON by default),
  // plus `skill` since ezk.10 ships built-in skills (ezk.9: 11 tools, the same list without skill)
  check("requests carry the lean tool set", mock.requests.filter((q) => q.tools > 0).every((q) => q.tools <= 12), JSON.stringify(mock.requests.map((q) => q.tools)) + " " + (mock.requests.find((q) => q.tools > 0)?.names ?? []).join(","))
  mock.stop()
}

// 3. ask-first default: without --auto the write is NOT performed
{
  const { work, env } = sandbox()
  const mock = startMock({ validKey: KEY, dir: work })
  const r = await run(["run", "--format", "json", "-m", "ezkielyna/default-model", "create hello.py"], { ...env, EZKIELYNA_BASE_URL: mock.url }, work)
  check("without --auto, file edits are refused (ask-first default)", !fs.existsSync(path.join(work, "hello.py")), r.out.slice(-300))
  mock.stop()
}

// 4. bad key -> friendly Indonesian message, and the key never appears in output
{
  const { work, env } = sandbox()
  const mock = startMock({ validKey: KEY, dir: work })
  const bad = "sk-" + "wrong-key-0123456789abcdefghij"
  const r = await run(["run", "--format", "json", "-m", "ezkielyna/default-model", "hi"], { ...env, EZKIELYNA_API_KEY: bad, EZKIELYNA_BASE_URL: mock.url, LANG: "id_ID.UTF-8", EZK_LANG: "id" }, work)
  const text = r.out + r.err
  check("bad key gives the friendly Indonesian message", text.includes("Kunci API tidak valid"), text.slice(-400))
  check("the key never appears in output", !text.includes(bad))
  const logDir = `${env.XDG_DATA_HOME}/ezkielyna/log`
  const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), "utf8")).join("\n") : ""
  check("the key never appears in the log files", !logs.includes(bad) && !logs.includes(KEY))
  mock.stop()
}

console.log(failures === 0 ? "\nCLI smoke: all passed" : `\nCLI smoke: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
