// Desktop smoke test: launch the packaged app against the mock gateway, check the home screen, keyboard focus and
// contrast, run a task end to end, then quit.
//   bun scripts/ezk/e2e/desktop_smoke.ts <app executable> [app dir for an unpackaged electron run]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startMock } from "./mock_openai"

const exe = process.argv[2] ? path.resolve(process.argv[2]) : ""
if (!exe || !fs.existsSync(exe)) throw new Error(`usage: desktop_smoke.ts <app executable> (got ${exe})`)
const KEY = "sk-" + "mock-test-key-0123456789abcdef"
let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const noKeyMode = process.env.EZK_SMOKE_NOKEY === "1"
const noKeyPhaseStatus = await (async () => {
  if (noKeyMode || process.env.EZK_SMOKE_SKIP_NOKEY === "1") return 0
  console.log("Desktop smoke: validating an isolated empty profile before the mock-key task phase")
  const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    env: { ...process.env, EZK_SMOKE_NOKEY: "1", EZK_SMOKE_SKIP_NOKEY: "1", EZK_TEST_HIDDEN: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return await child.exited
})()

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-desk-"))
const userData = path.join(root, "user")
const work = path.join(userData, "Default Project")
fs.mkdirSync(work, { recursive: true })
const shellHome = path.join(root, "shell")
fs.mkdirSync(shellHome, { recursive: true })
const realShell = process.platform === "darwin" && fs.existsSync("/bin/zsh") ? "/bin/zsh" : process.env.SHELL || "/bin/sh"
const shell = process.platform === "win32" ? realShell : path.join(shellHome, "smoke-shell")
if (process.platform !== "win32") {
  fs.writeFileSync(
    shell,
    `#!/bin/sh\nif [ "$1" = "-il" ] && [ "$2" = "-c" ] && [ "$3" = "env -0" ]; then exec /usr/bin/env -0; fi\nexec ${JSON.stringify(realShell)} "$@"\n`,
    { mode: 0o700 },
  )
  fs.chmodSync(shell, 0o700)
}
const configDir = path.join(root, ".config", "ezkielyna")
fs.mkdirSync(configDir, { recursive: true })
fs.writeFileSync(path.join(configDir, "ezkielyna.json"), JSON.stringify({ ezk: { router: { policyURL: "" } } }))
const mock = (() => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const port = 40000 + Math.floor(Math.random() * 20000)
    try { return startMock({ validKey: KEY, dir: work, port }) } catch (error) {
      if (!/EADDRINUSE|port \d+ in use/i.test(String(error))) throw error
    }
  }
  throw new Error("could not reserve a local mock gateway port")
})()
const env: Record<string, string | undefined> = { ...process.env }
// Keep every profile/config/database path inside this temporary root and strip ambient credentials.
for (const key of Object.keys(env)) {
  if (key !== "XAUTHORITY" && /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key)) delete env[key]
}
if (!noKeyMode) env.EZKIELYNA_API_KEY = KEY
env.EZKIELYNA_BASE_URL = mock.url
Object.assign(env, {
  HOME: root,
  SHELL: shell,
  ZDOTDIR: shellHome, // keep interactive login shells away from the owner's dotfiles
  OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: configDir,
  OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  EZK_NO_KEYCHAIN: "1",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  all_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
  XDG_CONFIG_HOME: `${root}/c`, XDG_DATA_HOME: `${root}/d`, XDG_CACHE_HOME: `${root}/k`, XDG_STATE_HOME: `${root}/s`,
  EZK_USER_DATA_DIR: userData,
  EZK_TEST_HIDDEN: "1", // the window is rendered but never shown to the user
})
// unpackaged (dev) runs always open port 9222 themselves; packaged runs take our flag
const unpackaged = !!process.argv[3] && !process.argv[3].startsWith("--")
const PORT = unpackaged ? 9222 : 9300 + Math.floor(Math.random() * 500)
const args = [`--remote-debugging-port=${PORT}`, ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [])]
// optional second argument: app directory (unpackaged run: `electron <dir>`)
const appDir = process.argv[3] && !process.argv[3].startsWith("--") ? [path.resolve(process.argv[3])] : []
// no-key mode: the key is saved through the UI (source "api", so Disconnect is offered); a dead proxy keeps the sidecar off the real network
if (noKeyMode) delete env.EZKIELYNA_BASE_URL
const app = Bun.spawn([exe, ...appDir, ...args], { env, cwd: work, stdout: "pipe", stderr: "pipe" })

async function pageWs(): Promise<string> {
  for (let i = 0; i < 90; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as any[]
      const page = list.find((t) => t.type === "page" && String(t.url).includes("renderer"))
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(1000)
  }
  throw new Error("the app window never appeared")
}
const ws = new WebSocket(await pageWs())
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map<number, (v: any) => void>()
let onEvent: (d: any) => void = () => {}
const cdpTimeout = process.env.EZK_SMOKE_SLOW === "1" ? 45000 : 15000
ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.method) return onEvent(d); pending.get(d.id)?.(d) }
ws.onclose = () => { for (const resolve of pending.values()) resolve({ error: { message: "CDP connection closed" } }); pending.clear() }
ws.onerror = () => { for (const resolve of pending.values()) resolve({ error: { message: "CDP connection failed" } }); pending.clear() }
const cdp = (method: string, params: object = {}) => new Promise<any>((res) => {
  const i = ++id
  let settled = false
  const finish = (value: any) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    pending.delete(i)
    res(value)
  }
  const timer = setTimeout(() => finish({ error: { message: `CDP timeout: ${method}` } }), cdpTimeout)
  pending.set(i, finish)
  try { ws.send(JSON.stringify({ id: i, method, params })) }
  catch (error) { finish({ error: { message: String(error) } }) }
})
const ev = async (expression: string) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
const text = () => ev("document.body.innerText")
const ezk8Headline = /Mau dikerjakan apa hari ini\?|What should we work on today\?/i
const ezk7Headline = /makes work easier|bikin kerja lebih gampang/i
let uiGeneration: "ezk.7" | "ezk.8" | "unknown" | undefined
async function detectUiGeneration() {
  if (uiGeneration) return uiGeneration
  // The headline can render a few seconds after the sidebar on slow hosts (capped VPS container + Xvfb): wait for it.
  let body = (await text()) ?? ""
  for (let i = 0; i < 40 && !ezk8Headline.test(body) && !ezk7Headline.test(body); i++) {
    await Bun.sleep(500)
    body = (await text()) ?? ""
  }
  uiGeneration = ezk8Headline.test(body) ? "ezk.8" : ezk7Headline.test(body) ? "ezk.7" : "unknown"
  console.log(`Desktop UI generation: ${uiGeneration}`)
  check("UI generation is recognized from the home headline", uiGeneration !== "unknown", body.slice(0, 200))
  return uiGeneration
}
async function waitForSidebarHydration() {
  return waitFor("sidebar hydration (Rosetta-safe)", async () => {
    const side = (await ev(`document.querySelector('aside')?.innerText ?? ''`)) ?? ""
    return /(New task|Tugas baru)/i.test(side) && /(Plugins|Plugin)/i.test(side) && /(Memory|Memori)/i.test(side)
  }, 30000)
}
async function checkEzk8Home(generation: "ezk.7" | "ezk.8" | "unknown") {
  if (generation !== "ezk.8") return
  const body = (await text()) ?? ""
  check("ezk.8 headline is shown in Indonesian or English", ezk8Headline.test(body), body.slice(0, 200))
  const legacySwitch = await ev(`(() => [...document.querySelectorAll('aside [role="group"]')].some((el) => { const words = (el.innerText || '').toLowerCase().split(/\\s+/); return (words.includes('local') || words.includes('lokal')) && words.includes('cloud') }))()`)
  check("ezk.8 sidebar has no Local/Cloud switch", legacySwitch === false, String(legacySwitch))
  const suggestions = await ev(`document.querySelectorAll('[data-component="session-new-design"] .ezk-home-suggestion').length`)
  check("ezk.8 home shows four suggestion cards", suggestions === 4, String(suggestions))
  const badgeReady = await waitFor("test profile badge hydration", async () => !!(await ev(`document.querySelector('[data-component="ezk-test-profile-badge"]')?.innerText`)), 60000)
  const badge = (await ev(`document.querySelector('[data-component="ezk-test-profile-badge"]')?.innerText ?? ''`)) ?? ""
  check("ezk.8 shows the temporary Test profile / Profil uji badge", badgeReady && /Test profile|Profil uji/.test(badge), badge)
  const digitRun = await ev(`(() => { const values = [document.body.innerText, ...[...document.querySelectorAll('[aria-label],[aria-valuetext]')].flatMap((el) => [el.getAttribute('aria-label') || '', el.getAttribute('aria-valuetext') || ''])]; const a11y = values.join(' ').replaceAll('\\n', ' ').split(/\\s+/).filter(Boolean).join(' '); return a11y.includes('0 1 2 3 4 5 6 7 8 9') })()`)
  check("ezk.8 accessible text has no animated 0–9 counter run", digitRun === false, String(digitRun))
}
async function enableNewSessionLayout() {
  await ev(`(async () => { const key = 'settings.v3'; let value = {}; try { value = JSON.parse((await window.api.storeGet('opencode.global.dat', key)) || '{}') } catch {} value.general = { ...(value.general || {}), newLayoutDesigns: true }; await window.api.storeSet('opencode.global.dat', key, JSON.stringify(value)); location.reload(); return true })()`)
  const ready = await waitFor("home after enabling session layout", async () => ezk8Headline.test((await text()) ?? "") || ezk7Headline.test((await text()) ?? ""), 30000)
  check("new session layout is enabled for the session smoke", ready)
  return ready
}
// EZK_SHOT_DIR=<dir>: also write PNG screenshots of the renderer (hidden window, taken through devtools, nothing appears on screen)
const SHOTS = process.env.EZK_SHOT_DIR
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const shot = async (name: string) => {
  if (!SHOTS) return
  const r = await cdp("Page.captureScreenshot", { format: "png" })
  if (r.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"))
}
// Escape and wait until the modal is really gone (fixed sleeps are too short under Rosetta emulation)
async function closeDialog() {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await waitFor("dialog closed", async () => (await ev(`!document.querySelector('[role=dialog],[data-component=dialog]')`)) === true, 15000)
}
// EZK_SMOKE_SLOW=1 triples every wait (the Intel app runs under Rosetta emulation here, on a busy 8 GB machine)
const SLOW = process.env.EZK_SMOKE_SLOW === "1" ? 3 : 1
async function waitFor(what: string, fn: () => Promise<boolean>, ms = 60000) {
  const end = Date.now() + ms * SLOW
  while (Date.now() < end) {
    if (app.exitCode !== null || ws.readyState !== WebSocket.OPEN) return false
    try { if (await fn()) return true } catch {}
    await sleep(500)
  }
  return false
}

const CONTRAST = `(() => {
  const lum = (r,g,b) => { const f = c => (c/=255) <= .03928 ? c/12.92 : ((c+.055)/1.055)**2.4; return .2126*f(r)+.7152*f(g)+.0722*f(b) }
  const parse = s => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r:p[0], g:p[1], b:p[2], a:p[3] ?? 1 } }
  const bgOf = el => { let layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= .99) break } } let base = { r:255, g:255, b:255 }; for (const l of layers.reverse()) base = { r: l.r*l.a + base.r*(1-l.a), g: l.g*l.a + base.g*(1-l.a), b: l.b*l.a + base.b*(1-l.a) }; return base }
  const bad = []; const seen = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n; (n = walker.nextNode()); ) {
    const t = n.textContent.trim(); const el = n.parentElement
    if (!t || !el || seen.has(el)) continue; seen.add(el)
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue
    if (el.closest('[aria-hidden=true],[disabled],[aria-disabled=true],svg,.sr-only')) continue
    const fg = parse(cs.color); if (!fg) continue
    const bg = bgOf(el); const a = fg.a
    const mix = { r: fg.r*a + bg.r*(1-a), g: fg.g*a + bg.g*(1-a), b: fg.b*a + bg.b*(1-a) }
    const L1 = lum(mix.r,mix.g,mix.b), L2 = lum(bg.r,bg.g,bg.b); const ratio = (Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05)
    const size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700)
    if (ratio < (large ? 3 : 4.5)) bad.push({ t: t.slice(0, 40), ratio: +ratio.toFixed(2), size })
  }
  return bad })()`

try {
if (noKeyMode) {
  // Verify an actually empty first-run field. Do not submit a key here: macOS may store it in the system Keychain.
  onEvent = (d) => {
    if (d.method !== "Fetch.requestPaused") return
    const hdr = [{ name: "content-type", value: "application/json" }, { name: "access-control-allow-origin", value: "*" }, { name: "access-control-allow-headers", value: "*" }, { name: "access-control-allow-methods", value: "*" }]
    const options = d.params.request.method === "OPTIONS"
    const body = options ? "" : JSON.stringify({ error: { message: "No test key submitted" } })
    void cdp("Fetch.fulfillRequest", { requestId: d.params.requestId, responseCode: options ? 200 : 401, responseHeaders: hdr, body: Buffer.from(body).toString("base64") })
  }
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*api.ezkielyna.store/v1/models*" }] })
  await waitFor("first-run screen or legacy home", async () => {
    const body = (await text()) ?? ""
    return /Connect Ezkielyna|Hubungkan Ezkielyna/.test(body) || ezk8Headline.test(body) || ezk7Headline.test(body)
  }, 60000)
  let first = (await text()) ?? ""
  await shot("desktop-nokey-first-launch")
  const generation = await detectUiGeneration()
  let keyInput = await ev(`!!document.querySelector('[data-input="ezk-change-api-key"]')`)
  // On ezk.8 the empty-profile home can render before the first-run dialog. Follow its visible Add key action if it hasn't opened yet.
  if (generation === "ezk.8" && !keyInput) {
    await ev(`(() => { const button = document.querySelector('.ezk-account-add-key'); button?.click(); return !!button })()`)
    keyInput = await waitFor("first-launch API-key field", async () => (await ev(`!!document.querySelector('[data-input="ezk-change-api-key"]')`)) === true, 15000)
    first = (await text()) ?? ""
  }
  if (!keyInput) {
    if (generation === "ezk.7") console.log("ezk.7 first-launch key check skipped: the installed legacy UI opened its home screen")
    else check("ezk.8 empty profile can open the first-launch key step", false, first.slice(0, 200))
  } else {
    check("first launch with no key shows the key step", true, first.slice(0, 200))
    check("no key: nothing says the API key is connected", !/API key connected|API key terhubung|Kunci API terhubung/i.test(first), (first.match(/.{0,30}(API key connected|terhubung).{0,20}/i) ?? [""])[0])
    const typeAttr = await ev(`document.querySelector('[data-input="ezk-change-api-key"]')?.type ?? document.querySelector('input[name=apiKey]')?.type`)
    check("the key field is masked (password input)", typeAttr === "password", String(typeAttr))
    const keyValue = await ev(`document.querySelector('[data-input="ezk-change-api-key"]')?.value ?? document.querySelector('input[name=apiKey]')?.value ?? null`)
    check("the first-launch key field starts empty", keyValue === "", String(keyValue))
  }
} else {
  // 1. home renders
  const rendered = await waitFor("home", async () => ezk8Headline.test((await text()) ?? "") || ezk7Headline.test((await text()) ?? ""))
  check("home screen renders a supported Ezkielyna headline", rendered, (await text())?.slice(0, 200))
  const generation = await detectUiGeneration()
  const sidebarReady = await waitForSidebarHydration()
  check("sidebar and memory controls hydrate before checks (Rosetta-safe)", sidebarReady)
  const body = (await text()) ?? ""
  const sidebarText = (await ev(`document.querySelector('aside')?.innerText ?? ''`)) ?? ""
  const sidebarBase = /(New task|Tugas baru)/i.test(sidebarText) && /(Plugins|Plugin)/i.test(sidebarText) && /(Projects|Proyek)/i.test(sidebarText)
  if (generation === "ezk.7") {
    check("ezk.7 sidebar has New task / Plugins / Local + Cloud / Projects", sidebarBase && /Cloud/.test(sidebarText))
    check("ezk.7 quick-start chips include Motion graphic soon", /(Code|Kode)/.test(body) && /Motion graphic/.test(body) && /(soon|segera)/i.test(body))
  } else if (generation === "ezk.8") {
    check("ezk.8 sidebar has New task / Plugins / Projects", sidebarBase)
    await checkEzk8Home(generation)
  }
  check("no upstream branding on screen", !/opencode/i.test(body), body.match(/.{20}opencode.{20}/i)?.[0] ?? "")
  const modelShown = await waitFor("model", async () => /Auto/.test(await text()), 30000)
  check("model picker shows Auto (default-model alias)", modelShown, (await text())?.slice(0, 300))

  // 1b. regression: stdout/stderr closed under the app (owner bug: "Uncaught Exception: Error: write EPIPE" dialog)
  await app.stdout.cancel().catch(() => {})
  await app.stderr.cancel().catch(() => {})
  await ev(`(() => { for (let i = 0; i < 300; i++) console.error('log line after the pipe closed ' + i); return 1 })()`)
  await sleep(1500)
  check("app survives closed stdout/stderr pipes while logging (no crash dialog, no exit)", app.exitCode === null && (ezk8Headline.test((await text()) ?? "") || ezk7Headline.test((await text()) ?? "")))

  // 2. keyboard and focus
  const tabbed = await ev(`(async () => { const seen = []; for (let i = 0; i < 12; i++) { document.activeElement?.blur?.(); } return true })()`)
  void tabbed
  const focusable = await ev(`[...document.querySelectorAll('aside button, [data-component="session-new-design"] button')].filter(b => !b.disabled).length`)
  check("sidebar and home buttons are real focusable buttons", focusable >= 8, String(focusable))
  // first launch: the memory notice is a dismissable bar in the sidebar (ux-firstrun); the Memory dialog can still open on its own
  const NOTICE = /Memory on\. Open Memory|Memori aktif\. Buka menu Memori|Memory is on by default|Memori aktif secara bawaan/
  const noticeText = async () => ((await ev(`(document.querySelector('[data-component="ezk-memory-notice"]')?.innerText ?? '') + ' ' + (document.querySelector('[data-component="ezk-memory"]')?.innerText ?? '')`)) as string) ?? ""
  const noticeShown = await waitFor("memory notice", async () => NOTICE.test(await noticeText()), 15000)
  check("first launch shows the memory notice", noticeShown)
  await shot("desktop-first-launch-memory-notice")
  await ev(`(() => { const b = document.querySelector('[data-component="ezk-memory-notice"] button') ?? [...document.querySelectorAll('[data-component="ezk-memory"] button')].find(b => /Got it|Mengerti/.test(b.textContent)); b?.click(); return !!b })()`)
  const noticeGone = await waitFor("notice dismissed", async () => !NOTICE.test(await noticeText()), 10000)
  check("the memory notice can be dismissed", noticeGone)
  await shot("desktop-after-dismiss")
  // Escape with no dialog open collapses the sidebar, so only press it when the Memory dialog really opened
  if ((await ev(`!!document.querySelector('[role=dialog],[data-component=dialog]')`)) === true) await closeDialog()
  await shot("desktop-home-before-tab")
  if (process.env.EZK_SMOKE_DEBUG) console.log("DEBUG", JSON.stringify(await ev(`(() => { const a = document.querySelector('aside'); const b = [...a.querySelectorAll('button')].find(b => /Plugins/.test(b.textContent)); const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + 5, r.y + 5); let inert = []; for (let e = a; e; e = e.parentElement) if (e.inert || e.hasAttribute('inert') || e.getAttribute('aria-hidden') === 'true') inert.push(e.tagName + '.' + String(e.className).slice(0,40)); return { top: top?.tagName + ' ' + String(top?.className).slice(0, 80) + ' ' + (top?.closest('[data-component]')?.getAttribute('data-component') ?? ''), inert, active: document.activeElement?.tagName + ' ' + String(document.activeElement?.className).slice(0,50), attrs: [...document.querySelectorAll("aside, aside button")].slice(0,3).map(e => e.tagName + " tabindex=" + e.getAttribute("tabindex") + " disabled=" + e.disabled + " vis=" + getComputedStyle(e).visibility + " pe=" + getComputedStyle(e).pointerEvents), chain: (() => { const out = []; for (let e = a; e && out.length < 8; e = e.parentElement) out.push(e.tagName + (e.getAttribute("data-component") ? "[" + e.getAttribute("data-component") + "]" : "") + " ti=" + e.getAttribute("tabindex") + " inert=" + e.inert + " vis=" + getComputedStyle(e).visibility + " disp=" + getComputedStyle(e).display); return out })(), tabbables: a.querySelectorAll('button:not([tabindex="-1"])').length } })()`)))
  // real keyboard navigation: Tab until focus lands inside the sidebar, then read the focus ring
  await ev(`document.activeElement?.blur?.(); document.body.focus(); 1`)
  let ring = ""
  const trail: string[] = []
  if (process.env.EZK_SMOKE_DEBUG) {
    const seq: any[] = []
    for (let k = 0; k < 10; k++) { seq.push(await ev(`document.querySelectorAll('aside').length + ':' + (document.body.innerText.includes('New task') ? 'T' : '-')`)); await sleep(1000) }
    console.log("TIMELINE", JSON.stringify(seq))
    const cnt = `document.querySelectorAll('aside').length`
    await ev(`document.activeElement?.blur?.(); 1`); seq.length = 0; seq.push("afterBlur:" + await ev(cnt))
    await ev(`document.body.focus(); 1`); seq.push("afterBodyFocus:" + await ev(cnt))
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); seq.push("afterTabDown:" + await ev(cnt))
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); await sleep(500); seq.push("afterTabUp:" + await ev(cnt) + " active=" + await ev(`document.activeElement?.tagName + ':' + (document.activeElement?.getAttribute('aria-label')||'')`))
    console.log("STEPS", JSON.stringify(seq))
  }
  if (process.env.EZK_SMOKE_DEBUG) {
    const lab = `(document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || document.activeElement?.tagName || '').trim().slice(0,18)`
    const res: any[] = [await ev(`(() => { const b = [...document.querySelectorAll('aside button')][0]; b.focus(); return document.activeElement === b })()`)]
    for (let k = 0; k < 4; k++) { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); res.push(await ev(lab)) }
    console.log("COUNTS", JSON.stringify(await ev(`({ allButtons: document.querySelectorAll('button').length, asideButtons: document.querySelectorAll('aside button').length, asides: document.querySelectorAll('aside').length, sel: document.querySelectorAll('button:not([disabled])').length, inAside: [...document.querySelectorAll('aside button')].map(b => b.matches('button:not([disabled])') + ':' + b.getAttribute('aria-label')).slice(0,4) })`)))
    console.log("ORDER", JSON.stringify(await ev(`[...document.querySelectorAll('a[href],button:not([disabled]),input,textarea,select,[tabindex],[contenteditable="true"]')].map(e => (e.closest('aside') ? 'A:' : '') + (e.getAttribute('tabindex') ? 'ti' + e.getAttribute('tabindex') + ':' : '') + (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 12))`)))
    console.log("FOCUSAPI", JSON.stringify(res))
    await ev(`document.activeElement?.blur?.(); document.body.focus(); 1`)
  }
  for (let i = 0; i < 150 && !ring; i++) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 })
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 })
    if (process.env.EZK_SMOKE_DEBUG && i < 40) trail.push(((await ev(`(document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || document.activeElement?.tagName || '').trim().slice(0,18)`)) as string) ?? "")
    ring = (await ev(`(() => { const a = document.activeElement; if (!a || !a.closest('aside')) return ''; const cs = getComputedStyle(a); return cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + (a.textContent||'').trim().slice(0,20) })()`)) ?? ""
  }
  if (process.env.EZK_SMOKE_DEBUG) console.log("TRAIL", JSON.stringify(trail))
  check("keyboard Tab reaches the sidebar and shows a visible focus ring", /solid|auto/.test(ring) && !/ 0px/.test(ring), ring || `no focus inside the sidebar after 150 Tabs; active=${await ev(`document.activeElement?.tagName + ' ' + (document.activeElement?.className||'').toString().slice(0,60) + ' ' + (document.activeElement?.getAttribute('aria-label')||'')`)}`)

  // 2b. regression (owner bug): Plugins opened the MCP dialog outside the SDK provider and crashed the page
  await ev(`(() => { const b = [...document.querySelectorAll('aside button')].find(b => /Plugins|Plugin/.test(b.textContent)); b?.click(); return !!b })()`)
  const pluginsOpen = await waitFor("plugins dialog", async () => (await ev(`!!document.querySelector('[role=dialog],[data-component=dialog]')`)) === true, 15000)
  const afterPlugins = (await text()) ?? ""
  check("Plugins opens the MCP dialog without crashing", pluginsOpen && !/Something went wrong|SDK context must be used/i.test(afterPlugins), afterPlugins.slice(0, 200))
  check("no upstream product name in the Plugins dialog (brandText regression)", !/opencode/i.test(afterPlugins), (afterPlugins.match(/.{0,40}opencode.{0,40}/i) ?? [""])[0])
  await closeDialog()

  // 3. contrast, both themes
  for (const scheme of ["light", "dark"]) {
    await ev(`localStorage.setItem('opencode-color-scheme','${scheme}'); location.reload(); 1`)
    await waitFor("home after theme change", async () => ezk8Headline.test((await text()) ?? "") || ezk7Headline.test((await text()) ?? ""), 30000)
    await shot(`desktop-home-${scheme}`)
    // the probe can return undefined while the page re-renders after the scheme switch; that is a failed check, not a crash
    const bad = ((await ev(CONTRAST)) ?? null) as { t: string; ratio: number }[] | null
    check(`text contrast passes WCAG AA in ${scheme} mode`, bad !== null && bad.length === 0, bad === null ? "contrast probe returned nothing" : JSON.stringify(bad.slice(0, 8)))
  }

  // 4. run a task end to end (auto-approve chip on)
  if (generation === "ezk.8") await enableNewSessionLayout()
  await ev(`localStorage.setItem('opencode-color-scheme','light'); location.reload(); 1`)
  await waitFor("home before mock task", async () => ezk8Headline.test((await text()) ?? "") || ezk7Headline.test((await text()) ?? ""), 30000)
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => /Ask before acting|Tanya izin dulu/.test(b.textContent)); b?.click(); return !!b })()`)
  await ev(`document.querySelector('[contenteditable="true"]').focus(); 1`)
  await cdp("Input.insertText", { text: "create hello.py, change it, run it" })
  await sleep(500)
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" })
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  if (generation === "ezk.8") {
    const permissionState = async () => (await ev(`(() => { const card = document.querySelector('[data-component="session-permission-inline"]') ?? [...document.querySelectorAll('[role="alertdialog"]')].find((el) => /Enter.*(once|sekali)/i.test(el.innerText)); return card ? JSON.stringify([card.getAttribute('aria-labelledby') || '', card.innerText || '']) : '' })()`)) as string
    const deadline = Date.now() + 60000 * SLOW
    const handled = new Set<string>()
    let firstPermissionAnswered = false
    // Flicker guard (ezk.8 bug): the inline card and the composer's permission dock render the same request, so at any
    // moment at most one of them may exist, and the card must not come and go while the same request is pending.
    const promptCounts = async () => { try { return JSON.parse((await ev(`JSON.stringify({ inline: document.querySelectorAll('[data-component="session-permission-inline"]').length, dock: document.querySelectorAll('[data-component="dock-prompt"][data-kind="permission"]').length })`)) as string) as { inline: number; dock: number } } catch { return undefined } }
    const flicker = { samples: 0, both: 0, toggles: 0, log: [] as string[] }
    let lastSampled: { state: string; inline: number } | undefined
    const samplePrompts = async (state: string) => {
      const counts = await promptCounts()
      if (!counts) return
      flicker.samples++
      if (counts.inline + counts.dock > 1) { flicker.both++; flicker.log.push(`both: ${JSON.stringify(counts)}`) }
      if (lastSampled && lastSampled.state === state && lastSampled.inline !== counts.inline) { flicker.toggles++; flicker.log.push(`toggle: inline ${lastSampled.inline} -> ${counts.inline} while the same request is pending`) }
      lastSampled = { state, inline: counts.inline }
    }
    let permissionWasAbsent = true
    let noPermissionSince = Date.now()
    while (Date.now() < deadline) {
      const current = await permissionState()
      const transcript = (await text()) ?? ""
      if (/Done: hello\.py prints the greeting\./.test(transcript)) break
      if (current) await samplePrompts(current)
      if (!current) {
        lastSampled = undefined
        permissionWasAbsent = true
        if (Date.now() - noPermissionSince > 30000 * SLOW) break
        await sleep(300)
        continue
      }
      noPermissionSince = Date.now()
      if (!handled.has(current) || permissionWasAbsent) {
        permissionWasAbsent = false
        handled.add(current)
        const enter = await ev(`(() => { const card = document.querySelector('[data-component="session-permission-inline"]') ?? [...document.querySelectorAll('[role="alertdialog"]')].find((el) => /Enter.*(once|sekali)/i.test(el.innerText)); if (!card) return ''; const state = JSON.stringify([card.getAttribute('aria-labelledby') || '', card.innerText || '']); const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }); card.dispatchEvent(event); return JSON.stringify({ state, handled: event.defaultPrevented }) })()`)
        if (!enter) { permissionWasAbsent = true; await sleep(100); continue }
        let enterState = current
        try { enterState = JSON.parse(enter).state ?? current } catch {}
        handled.add(enterState)
        console.log(`Sent Enter to inline permission: ${enter}`)
        // sample ~3 s around the transition to the next request, every animation frame
        const burst = await ev(`new Promise((resolve) => { const out = []; const t0 = performance.now(); const tick = () => { out.push(document.querySelectorAll('[data-component="session-permission-inline"]').length * 10 + document.querySelectorAll('[data-component="dock-prompt"][data-kind="permission"]').length); if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve(JSON.stringify(out)) }; requestAnimationFrame(tick) })`) as string
        try {
          const frames = JSON.parse(burst) as number[]
          const both = frames.filter((f) => Math.floor(f / 10) + (f % 10) > 1).length
          const changes = frames.filter((f, i) => i > 0 && f !== frames[i - 1]).length
          flicker.samples += frames.length
          if (both) { flicker.both += both; flicker.log.push(`both prompts in ${both} of ${frames.length} frames after Enter`) }
          // one request ending and the next starting is at most 2 changes (card off, card on); more means flicker
          if (changes > 2) { flicker.toggles += changes - 2; flicker.log.push(`prompt count changed ${changes}x in ${frames.length} frames after Enter: ${frames.join("")}`) }
        } catch {}
        const advanced = await waitFor("inline permission response", async () => (await permissionState()) !== current || /Done: hello\.py prints the greeting\./.test((await text()) ?? ""), 12000)
        if (!firstPermissionAnswered) firstPermissionAnswered = advanced
        if (!advanced) break
        continue
      }
      await sleep(300)
    }
    check("the mock requested inline permission and Enter allowed it once", handled.size > 0 && firstPermissionAnswered, `requests=${handled.size}`)
    check("one permission prompt at a time, no card/dock flicker", flicker.samples > 0 && flicker.both === 0 && flicker.toggles === 0, `samples=${flicker.samples} both=${flicker.both} toggles=${flicker.toggles}${flicker.log.length ? " " + flicker.log.slice(0, 3).join("; ") : ""}`)
    const done = await waitFor("mock task completion after inline permissions", async () => /Done: hello\.py prints the greeting\./.test((await text()) ?? ""), 60000)
    check("the mock task completes after inline permissions", done, ((await text()) ?? "").slice(-300))
    const headerReady = await waitFor("session header usage", async () => !!(await ev(`document.querySelector('[data-component="session-run-header"]')`)), 30000)
    const headerValues = await ev(`(() => { const root = document.querySelector('[data-component="session-run-header"]'); return { text: root?.innerText || '', tokens: root?.querySelector('.session-polish-stat:nth-child(2) strong')?.innerText || '', cost: root?.querySelector('.session-polish-stat-cost strong')?.innerText || '' } })()`)
    check("session header shows token usage and cost", headerReady && /\d/.test(headerValues?.tokens ?? "") && /\$|Rp/.test(headerValues?.cost ?? ""), JSON.stringify(headerValues))
    const doneCard = done && await waitFor("Selesai card with changed file", async () => {
      const card = (await ev(`document.querySelector('[data-component="session-done-card"]')?.innerText ?? ''`)) as string
      return /Selesai|Done/.test(card) && /hello\.py/i.test(card)
    }, 15000)
    const doneText = (await ev(`document.querySelector('[data-component="session-done-card"]')?.innerText ?? ''`)) ?? ""
    check(
      "Selesai card lists the edited hello.py file",
      !!doneCard,
      doneText || `no session-done-card rendered; transcript=${((await text()) ?? "").slice(-220)}`,
    )
    const digitRun = await ev(`(() => { const values = [document.body.innerText, ...[...document.querySelectorAll('[aria-label],[aria-valuetext]')].flatMap((el) => [el.getAttribute('aria-label') || '', el.getAttribute('aria-valuetext') || ''])]; return values.join(' ').replaceAll('\\n', ' ').split(/\\s+/).filter(Boolean).join(' ').includes('0 1 2 3 4 5 6 7 8 9') })()`)
    check("ezk.8 session accessible text has no animated 0–9 counter run", digitRun === false, String(digitRun))
  }
  const done = generation === "ezk.8" ? /Done: hello\.py prints the greeting\./.test((await text()) ?? "") : await waitFor("task", async () => /Done: hello\.py prints the greeting/.test(await text()), 90000)
  await shot("desktop-task-done")
  check("task ran end to end against the mock (transcript shows the answer)", done, (await text())?.slice(-300))
  check("packaged app stayed alive through the mock task", app.exitCode === null, `exit=${app.exitCode}`)
  const file = path.join(work, "hello.py")
  check("the agent created and edited the file", fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("hello from mock"))
  const listed = await waitFor("sidebar task", async () => /Hello script/i.test((await ev(`document.querySelector('aside')?.innerText`)) ?? ""), 25000)
  check("sidebar Projects list shows the new task live (no reload)", listed, ((await ev(`document.querySelector('aside')?.innerText`)) ?? "").slice(0, 300))

  // 5. integrated v1.1 features (router badge, memory, FTS5 session search through node:sqlite, skills queue)
  const turnBadge = await waitFor("route badge", async () => /gateway auto|pinned|auto (light|medium|heavy)|auto gateway|dipin/i.test(await text()), 20000)
  check("the assistant turn shows its model route badge", turnBadge, ((await text()) ?? "").slice(-200))
  const skills = await ev(`(async () => { try { const r = await window.api.skills.pending(); return Array.isArray(r) ? r.length : -1 } catch (e) { return String(e) } })()`)
  check("skills approval queue answers over IPC and starts empty", skills === 0, String(skills))
  await ev(`document.querySelector('aside button[aria-label="Memory"],aside button[aria-label="Memori"]')?.click(); 1`)
  const memOpen = await waitFor("memory dialog", async () => (await ev(`!!document.querySelector('[data-component="ezk-memory"]')`)) === true, 20000)
  const memText = ((await ev(`document.querySelector('[data-component="ezk-memory"]')?.innerText`)) as string) ?? ""
  check("memory dialog opens with the private-session toggle and the erase button", memOpen && /Private session|Sesi privat/.test(memText) && /Erase memory|Hapus memori/.test(memText), memText.slice(0, 200))
  check("memory dialog has no upstream product name", !/opencode/i.test(memText), memText.slice(0, 120))
  await shot("desktop-memory-dialog")
  await closeDialog()
  await ev(`document.querySelector('aside button[aria-label="Search sessions"],aside button[aria-label="Cari sesi"]')?.click(); 1`)
  const searchOpen = await waitFor("search dialog", async () => (await ev(`!!document.querySelector('[data-component="ezk-search"] input')`)) === true, 20000)
  await ev(`document.querySelector('[data-component="ezk-search"] input').focus(); 1`)
  await cdp("Input.insertText", { text: "hello" })
  const hit = await waitFor("search hit", async () => /hello/i.test(((await ev(`document.querySelector('[data-component="ezk-search"]')?.innerText`)) as string) ?? "") && (await ev(`document.querySelectorAll('[data-component="ezk-search"] button').length`)) > 0, 30000)
  check("session search dialog finds the earlier task through the FTS5 index (node:sqlite in the app)", searchOpen && hit, ((await ev(`document.querySelector('[data-component="ezk-search"]')?.innerText`)) as string)?.slice(0, 200))
  await shot("desktop-search-dialog")
  await closeDialog()

  // the model calls session_search itself from a second session (the first one holds the "hello" task)
  await ev(`(() => { const b = [...document.querySelectorAll('aside button')].find(b => /New task|Tugas baru/.test(b.textContent)); b?.click(); return !!b })()`)
  await sleep(2500)
  await ev(`document.querySelector('[contenteditable="true"]').focus(); 1`)
  await cdp("Input.insertText", { text: "session_search_scenario: what did we do earlier?" })
  await sleep(500)
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" })
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  const searched = await waitFor("session_search answer", async () => /Search finished: found the earlier hello script/.test(await text()), 90000)
  check("the model's session_search tool call ran and the answer arrived", searched, (await text())?.slice(-300))
  check("session_search returned the earlier session (tool result seen by the model)", mock.toolResults.some((r) => /hello/i.test(r) && !/no (matches|results)/i.test(r)), JSON.stringify(mock.toolResults.slice(-2)).slice(0, 300))
  await shot("desktop-session-search")
}
} catch (e) {
  check("smoke run completed without an exception", false, String(e))
} finally {
  void cdp("Browser.close") // not awaited: the browser closes before it can answer
  await sleep(1500)
  try { app.kill() } catch {}
  await Promise.race([app.exited, sleep(3000)])
  mock.stop()
  fs.rmSync(root, { recursive: true, force: true })
}
if (noKeyPhaseStatus !== 0) check("empty-profile first-launch phase passed before mock-key phase", false, `exit=${noKeyPhaseStatus}`)
console.log(failures === 0 ? "\nDesktop smoke: all passed" : `\nDesktop smoke: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
