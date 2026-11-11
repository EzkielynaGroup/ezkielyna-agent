import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { chromium } from "@playwright/test"

const out = path.resolve(process.argv[2] ?? "../../docs/v3/screenshots/firstrun")
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "ux-firstrun-render-"))
process.env.UX_FIRSTRUN_OUT = dist
await build({ configFile: path.join(import.meta.dir, "firstrun.vite.config.ts") })
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright")
const shell = fs.readdirSync(cache).filter((dir) => dir.startsWith("chromium_headless_shell-")).sort().at(-1)
const executable = shell ? path.join(cache, shell, "chrome-headless-shell-mac-arm64/chrome-headless-shell") : undefined
const browser = await chromium.launch({ headless: true, executablePath: executable && fs.existsSync(executable) ? executable : undefined })

try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 740 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  const consoleOutput: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => consoleOutput.push(message.text()))
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== "ux-firstrun.local") return route.abort()
    const relative = decodeURIComponent(url.pathname).replace(/^\/+$/, "firstrun.html").replace(/^\/+/, "")
    const root = path.resolve(dist)
    const file = path.resolve(root, relative)
    if (!file.startsWith(`${root}${path.sep}`) && file !== root) return route.fulfill({ status: 404 })
    try {
      const body = await fs.promises.readFile(file)
      const ext = path.extname(file)
      const contentType = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".woff2" ? "font/woff2" : "application/octet-stream"
      return route.fulfill({ status: 200, contentType, body })
    } catch {
      return route.fulfill({ status: 404 })
    }
  })
  fs.mkdirSync(out, { recursive: true })
  const scenes = [
    ["first-run", "first-run-id"],
    ["sidebar", "no-key-sidebar-id"],
    ["chat", "no-key-chat-error-id"],
    ["memory", "memory-info-bar-id"],
  ] as const
  for (const [scene, name] of scenes) {
    await page.goto(`http://ux-firstrun.local/firstrun.html?scene=${scene}`)
    const target = page.locator(`[data-scene="${scene}"]:not(body)`)
    try {
      await target.waitFor({ state: "visible", timeout: 5000 })
    } catch {
      const count = await target.count()
      const state = count ? await target.first().evaluate((element) => ({ html: element.outerHTML.slice(0, 500), rect: element.getBoundingClientRect().toJSON(), display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility })) : undefined
      throw new Error(`Scene ${scene} did not render; targetCount=${count}; targetState=${JSON.stringify(state)}; title=${await page.title()}; body=${(await page.locator("body").innerText().catch(() => "")).slice(0, 500)}; page errors=${errors.join("; ")}; console=${consoleOutput.join("; ").slice(0, 1000)}`)
    }
    const body = await page.locator("body").innerText()
    if (scene === "first-run") {
      if (!body.includes("Hubungkan Ezkielyna") || !body.includes("Dapatkan API key") || !body.includes("Beli paket")) throw new Error("First-run key step copy is incomplete")
      const input = target.locator('input[name="apiKey"]')
      if ((await input.getAttribute("type")) !== "password") throw new Error("First-run API key is not masked by default")
      if ((await input.getAttribute("autocomplete")) !== "off" || (await input.getAttribute("spellcheck")) !== "false") throw new Error("First-run API key field protections are missing")
      await target.locator('button[aria-pressed="false"]').first().evaluate((element) => (element as HTMLButtonElement).click())
      if ((await input.getAttribute("type")) !== "text") throw new Error("First-run eye control did not reveal the key field")
      await target.locator('button[aria-pressed="true"]').first().evaluate((element) => (element as HTMLButtonElement).click())
      if ((await input.getAttribute("type")) !== "password") throw new Error("First-run eye control did not re-mask the key field")
    }
    if (scene === "sidebar" && (!body.includes("Belum ada API key") || !body.includes("Tambahkan API key"))) throw new Error("Sidebar no-key state is missing its add-key action")
    if (scene === "chat") {
      if (!body.includes("Belum ada API key") || !body.includes("Tambahkan API key")) throw new Error("Chat error is missing its add-key action")
      if (/\/connect|invalid, deleted, or out of balance/i.test(body)) throw new Error("Desktop no-key error retained command or bad-key advice")
      await target.getByRole("button", { name: "Tambahkan API key" }).click({ force: true })
      await page.locator('[data-key-dialog-opened="true"]').waitFor({ state: "visible" })
    }
    if (scene === "memory") {
      const notice = target
      if ((await notice.evaluate((el) => getComputedStyle(el).flexWrap)) === "wrap") throw new Error("Memory notice should stay on one line")
      const text = notice.locator("span.flex-1")
      if (await text.evaluate((el) => el.scrollWidth > el.clientWidth)) throw new Error("Memory notice copy should fit on one line")
    }
    for (const scheme of ["light", "dark"] as const) {
      await page.locator("html").evaluate((element, value) => {
        ;(element as HTMLHtmlElement).dataset.colorScheme = value
      }, scheme)
      await target.screenshot({ path: path.join(out, `${name}-${scheme}.png`) })
    }
    if (scene === "memory") {
      await target.getByRole("button", { name: "Mengerti" }).click({ force: true })
      await target.waitFor({ state: "hidden" })
    }
  }
  if (errors.length) throw new Error(`Headless render errors: ${errors.join("; ")}`)
} finally {
  await browser.close()
  fs.rmSync(dist, { recursive: true, force: true })
}
console.log(`ID light/dark first-run screenshots saved to ${out}`)
