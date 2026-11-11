#!/usr/bin/env bun
// Smoke test for a packaged (unpacked-directory) Ezkielyna Agent desktop build.
//
//   bun scripts/ci/smoke-desktop.ts packages/desktop/dist/linux-unpacked      (Linux: run under xvfb-run)
//   bun scripts/ci/smoke-desktop.ts packages/desktop/dist/win-unpacked
//
// 1. Static: reads resources/app.asar, checks the entry files exist and that every package the main-process bundle
//    imports statically (the imports that are linked before any app code runs) is present in the package.
// 2. Live: launches the app hidden (EZK_TEST_HIDDEN=1) with a throwaway profile (EZK_USER_DATA_DIR) and waits for
//    the main process to log "loading task finished", i.e. the embedded server sidecar is up and healthy.
//
// Fails on a missing entry/package, on ERR_MODULE_NOT_FOUND (or similar) in the app's stdout/stderr or its log files,
// on a failed sidecar health check, or when the app does not get there within the timeout. No network, no API key.
import { builtinModules } from "node:module"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { BROKEN_BUNDLE, findBrokenBundle } from "./broken-bundle"
import { safeEnv } from "./safe-env"

const TIMEOUT_MS = 120_000
const dir = process.argv[2] ? path.resolve(process.argv[2]) : undefined
if (!dir || !(await Bun.file(path.join(dir, "resources", "app.asar")).exists())) {
  console.error(
    `usage: bun scripts/ci/smoke-desktop.ts <electron-builder *-unpacked dir> (got ${process.argv[2] ?? "nothing"})`,
  )
  process.exit(2)
}

const failures = [...(await checkAsar(dir)), ...(await launch(dir))]
if (failures.length > 0) {
  console.error(`\nDesktop smoke failed:\n${failures.map((item) => `  - ${item}`).join("\n")}`)
  process.exit(1)
}
console.log("\nDesktop smoke passed")

async function checkAsar(dir: string) {
  const asar = await readAsar(path.join(dir, "resources", "app.asar"))
  const entries = [
    "package.json",
    "out/main/boot.js",
    "out/main/index.js",
    "out/main/sidecar.js",
    "out/preload/index.js",
    "out/renderer/index.html",
  ]
  const missing = entries.filter((file) => !asar.files.has(file)).map((file) => `app.asar is missing ${file}`)

  const pkg = JSON.parse(await asar.read("package.json"))
  const main = pkg.main?.replace(/^\.\//, "")
  const badMain =
    main && !asar.files.has(main) ? [`package.json "main" points at ${main}, which is not in app.asar`] : []

  const builtins = new Set([...builtinModules, "electron"])
  const mainFiles = [...asar.files.keys()].filter((file) => file.startsWith("out/main/") && /\.(m?js|cjs)$/.test(file))
  const transpiler = new Bun.Transpiler({ loader: "js" })
  const imports = new Set(
    (await Promise.all(mainFiles.map((file) => asar.read(file)))).flatMap((code) =>
      // Static import/export-from statements only: dynamic imports are lazy by design (optional providers,
      // platform-specific code) and are covered by the live launch instead.
      transpiler
        .scanImports(code)
        .filter((item) => item.kind === "import-statement")
        .map((item) => item.path),
    ),
  )
  const packages = [...imports]
    .filter((spec) => !spec.startsWith(".") && !spec.startsWith("/"))
    .filter((spec) => !spec.startsWith("node:") && !builtins.has(spec.split("/")[0]!) && !builtins.has(spec))
    .map((spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!))
  const unresolved = [...new Set(packages)]
    .filter(
      (name) =>
        !asar.files.has(`node_modules/${name}/package.json`) && !asar.unpacked.has(`node_modules/${name}/package.json`),
    )
    .map((name) => `main process imports "${name}" but node_modules/${name} is not in the package`)

  console.log(
    `asar: ${asar.files.size} files, ${mainFiles.length} main-process chunks, ${new Set(packages).size} external packages imported statically`,
  )
  return [...missing, ...badMain, ...unresolved]
}

async function launch(dir: string) {
  const exe = await findExecutable(dir)
  const profile = await mkdtemp(path.join(tmpdir(), "ezk-desktop-smoke-"))
  const configDir = path.join(profile, ".config", "ezkielyna")
  const screenshotPath = process.env.EZK_SMOKE_FIRST_WINDOW_SCREENSHOT
  const debugPort = screenshotPath ? await availablePort() : undefined
  await mkdir(configDir, { recursive: true })
  await writeFile(path.join(configDir, "ezkielyna.json"), JSON.stringify({ ezk: { router: { policyURL: "" } } }))
  console.log(`launching ${exe} (profile ${profile})`)
  const proc = Bun.spawn([
    exe,
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []),
    ...(debugPort === undefined ? [] : [`--remote-debugging-port=${debugPort}`]),
  ], {
    cwd: profile,
    env: {
      ...safeEnv(process.env),
      EZK_TEST_HIDDEN: screenshotPath ? "0" : "1",
      EZK_USER_DATA_DIR: profile,
      XDG_CONFIG_HOME: path.join(profile, ".config"),
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_CONTENT: "{}",
      EZKIELYNA_BASE_URL: "http://127.0.0.1:1/v1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const output: string[] = []
  const drain = (stream: ReadableStream<Uint8Array>) =>
    (async () => {
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return
          output.push(chunk.value)
        }
      } finally {
        reader.releaseLock()
      }
    })()
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)])

  const started = performance.now()
  let result = await (async () => {
    while (performance.now() - started < TIMEOUT_MS) {
      await Bun.sleep(1000)
      const logs = await readLogs(profile)
      const all = output.join("") + logs
      const broken = findBrokenBundle(all)
      if (broken) return { ok: false, reason: `module resolution error: ${broken}` }
      if (all.includes("sidecar health check failed")) return { ok: false, reason: "sidecar health check failed" }
      // Printed by out/main/boot.js when the main bundle cannot even be loaded.
      if (all.includes("Ezkielyna Agent failed to start"))
        return { ok: false, reason: "app reported that it failed to start" }
      if (proc.exitCode !== null) return { ok: false, reason: `app exited early with code ${proc.exitCode}` }
      if (logs.includes("loading task finished")) return { ok: true, reason: "" }
    }
    return { ok: false, reason: `app did not report "loading task finished" within ${TIMEOUT_MS / 1000}s` }
  })()

  // Let the renderer load for a moment so a broken renderer bundle also shows up in renderer.log.
  if (result.ok) await Bun.sleep(5000)
  if (result.ok && screenshotPath && debugPort !== undefined) {
    try {
      await captureFirstWindow(debugPort, screenshotPath)
      console.log(`PASS first window screenshot captured via CDP: ${screenshotPath}`)
    } catch (error) {
      result = { ok: false, reason: `first window CDP screenshot failed: ${String(error)}` }
    }
  }
  // Windows: end the whole tree (renderer, GPU and sidecar utility processes) so nothing keeps the unpacked files busy.
  if (process.platform === "win32")
    await Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
  if (process.platform !== "win32") proc.kill()
  await Promise.race([proc.exited, Bun.sleep(10_000)])
  if (proc.exitCode === null) proc.kill("SIGKILL")
  await Promise.race([drained, Bun.sleep(5000)])

  const logs = await readLogs(profile)
  const late = result.ok ? findBrokenBundle(output.join("") + logs) : undefined
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  if (result.ok && !late) {
    console.log(`app started and sidecar is healthy (${seconds}s)`)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    return []
  }
  console.log(`--- app stdout/stderr (tail) ---\n${output.join("").slice(-6000)}`)
  console.log(`--- app log files (tail) ---\n${logs.slice(-12000)}`)
  console.log(`(patterns checked: ${BROKEN_BUNDLE.join(", ")})`)
  return [late ? `module resolution error after startup: ${late}` : result.reason]
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("could not reserve a loopback port for CDP")
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

async function captureFirstWindow(port: number, destination: string) {
  const deadline = Date.now() + 45_000
  let target: { type?: string; url?: string; webSocketDebuggerUrl?: string } | undefined
  while (Date.now() < deadline && !target) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined)
    if (response?.ok) {
      const targets = (await response.json().catch(() => [])) as { type?: string; url?: string; webSocketDebuggerUrl?: string }[]
      target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl && !item.url?.startsWith("devtools://"))
    }
    if (!target) await Bun.sleep(250)
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("no first-window page target appeared on the CDP endpoint")

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map<number, {
    resolve(value: Record<string, unknown>): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }>()
  socket.addEventListener("message", (event) => {
    const response = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
    if (response.id === undefined) return
    const wait = pending.get(response.id)
    if (!wait) return
    clearTimeout(wait.timer)
    pending.delete(response.id)
    if (response.error) wait.reject(new Error(response.error.message ?? "CDP command failed"))
    else wait.resolve(response.result ?? {})
  })
  const rejectPending = (error: Error) => {
    for (const [id, wait] of pending) {
      clearTimeout(wait.timer)
      pending.delete(id)
      wait.reject(error)
    }
  }
  socket.addEventListener("close", () => rejectPending(new Error("CDP WebSocket closed before replying")))
  socket.addEventListener("error", () => rejectPending(new Error("CDP WebSocket failed before replying")))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP WebSocket did not open")), 5000)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("CDP WebSocket could not connect"))
    }, { once: true })
  })
  let commandID = 0
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++commandID
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP command ${method} timed out`))
      }, 10_000)
      pending.set(id, { resolve, reject, timer })
    })
    socket.send(JSON.stringify({ id, method, params }))
    return response
  }
  try {
    await send("Page.enable")
    const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true })
    if (typeof screenshot.data !== "string") throw new Error("CDP returned no PNG bytes")
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, Buffer.from(screenshot.data, "base64"))
    console.log(`CDP first window: ${target.url ?? "unknown URL"}`)
  } finally {
    socket.close()
  }
}

async function findExecutable(dir: string) {
  const names = await readdir(dir)
  // Exact names per channel: an extracted AppImage also holds store.ezkielyna.agent.desktop, and an NSIS install
  // holds "Uninstall Ezkielyna Agent.exe".
  const pattern =
    process.platform === "win32" ? /^Ezkielyna Agent( Dev| Beta)?\.exe$/ : /^store\.ezkielyna\.agent(\.dev|\.beta)?$/
  const exe = names.find((name) => pattern.test(name))
  if (!exe) throw new Error(`no app executable in ${dir}: ${names.join(", ")}`)
  return path.join(dir, exe)
}

async function readLogs(profile: string) {
  const files = await Array.fromAsync(new Bun.Glob("logs/**/*.log").scan({ cwd: profile })).catch(() => [])
  const texts = await Promise.all(
    files.sort().map(
      async (file) =>
        `== ${file}\n${await Bun.file(path.join(profile, file))
          .text()
          .catch(() => "")}`,
    ),
  )
  return texts.join("\n")
}

// Minimal asar reader: an 8-byte size pickle, then a pickle holding the JSON header, then the file data.
async function readAsar(file: string) {
  const buffer = Buffer.from(await Bun.file(file).arrayBuffer())
  const headerSize = buffer.readUInt32LE(4)
  const header = JSON.parse(buffer.toString("utf8", 16, 16 + buffer.readUInt32LE(12)))
  const base = 8 + headerSize
  const files = new Map<string, { offset: number; size: number }>()
  const unpacked = new Set<string>()
  const walk = (node: AsarNode, prefix: string) =>
    Object.entries(node.files ?? {}).forEach(([name, child]) => {
      const key = prefix ? `${prefix}/${name}` : name
      if (child.files) return walk(child, key)
      if (child.unpacked) return unpacked.add(key)
      if (child.offset !== undefined) files.set(key, { offset: Number(child.offset), size: child.size ?? 0 })
    })
  walk(header, "")
  return {
    files,
    unpacked,
    read: async (name: string) => {
      const entry = files.get(name)
      if (!entry) throw new Error(`${name} is not in ${file}`)
      return buffer.toString("utf8", base + entry.offset, base + entry.offset + entry.size)
    },
  }
}

type AsarNode = { files?: Record<string, AsarNode>; offset?: string; size?: number; unpacked?: boolean }
