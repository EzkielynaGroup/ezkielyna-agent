// Ezkielyna e2e harness: runs the real `ezkielyna serve` (from source) in an isolated hidden profile against a mock
// gateway. No window, no network except 127.0.0.1. Everything lives in a temp dir that is removed on stop().
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface Server {
  url: string
  pid: number
  dir: string
  dirs: { data: string; config: string; cache: string; state: string; project: string }
  stop(): Promise<void>
  api<T = any>(method: string, p: string, body?: unknown): Promise<T>
  logs(): string
}

const ROOT = path.resolve(import.meta.dir, "../..")
const TEST_SERVER_PASSWORD = "ezk-local-e2e-only"

export async function startServer(input: {
  baseURL: string
  key?: string
  /** write auth.json with the key instead of env (default env) */
  authFile?: boolean
  config?: Record<string, unknown>
  env?: Record<string, string>
  /** write files into the isolated profile before the server starts */
  seed?: (dirs: Server["dirs"]) => void
}): Promise<Server> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-e2e-"))
  const dirs = {
    data: path.join(dir, "data"),
    config: path.join(dir, "config"),
    cache: path.join(dir, "cache"),
    state: path.join(dir, "state"),
    project: path.join(dir, "project"),
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  fs.mkdirSync(path.join(dirs.config, "ezkielyna"), { recursive: true })
  fs.mkdirSync(path.join(dirs.data, "ezkielyna"), { recursive: true })
  input.seed?.(dirs)
  if (input.config) fs.writeFileSync(path.join(dirs.config, "ezkielyna", "ezkielyna.json"), JSON.stringify(input.config))
  if (input.authFile && input.key)
    fs.writeFileSync(path.join(dirs.data, "ezkielyna", "auth.json"), JSON.stringify({ ezkielyna: { type: "api", key: input.key } }), { mode: 0o600 })
  // Ask the OS for a free port (a random number in a range collided with other listeners on CI: "server exited early: ServeError").
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = probe.port as number
  probe.stop(true)
  const proc = Bun.spawn(["bun", "run", "src/index.ts", "serve", "--print-logs", "--log-level", "ERROR", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      // Clean env: the bun test preload sets OPENCODE_* test flags (in-memory DB, fixtures) that must not leak into the server.
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OPENCODE_") && !k.startsWith("XDG_"))),
      HOME: dir,
      XDG_DATA_HOME: dirs.data,
      XDG_CONFIG_HOME: dirs.config,
      XDG_CACHE_HOME: dirs.cache,
      XDG_STATE_HOME: dirs.state,
      EZKIELYNA_BASE_URL: input.baseURL,
      EZK_SERVER_PASSWORD: TEST_SERVER_PASSWORD,
      ...(input.key && !input.authFile ? { EZKIELYNA_API_KEY: input.key } : { EZKIELYNA_API_KEY: "" }),
      EZK_TEST_HIDDEN: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      ...input.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  let out = ""
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      out += dec.decode(value)
    }
  }
  void pump(proc.stdout as ReadableStream<Uint8Array>)
  void pump(proc.stderr as ReadableStream<Uint8Array>)
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  for (;;) {
    if (/listening on/.test(out)) break
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${out}`)
    if (Date.now() > deadline) {
      proc.kill()
      throw new Error(`server did not start:\n${out}`)
    }
    await Bun.sleep(100)
  }
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${url}${p}${p.includes("?") ? "&" : "?"}directory=${encodeURIComponent(dirs.project)}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`ezkielyna:${TEST_SERVER_PASSWORD}`).toString("base64")}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 500)}`)
    return text ? JSON.parse(text) : undefined
  }
  return {
    url,
    pid: proc.pid,
    dir,
    dirs,
    api: api as Server["api"],
    logs: () => out,
    async stop() {
      proc.kill()
      await proc.exited.catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Send one user message with the given model and wait for the assistant reply (the endpoint blocks until done). */
export async function prompt(s: Server, sessionID: string, text: string, modelID: string, extra: Record<string, unknown> = {}) {
  return s.api("POST", `/session/${sessionID}/message`, {
    model: { providerID: "ezkielyna", modelID },
    parts: [{ type: "text", text }],
    ...extra,
  })
}

export const newSession = (s: Server, input: Record<string, unknown> = {}) => s.api<{ id: string }>("POST", "/session", input)
