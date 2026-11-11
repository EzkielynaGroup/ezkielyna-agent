import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { chromium } from "@playwright/test"

const out = path.resolve(process.argv[2] ?? "../../docs/v3/screenshots/uxsafety")
const fakeKey = "sk-test_fake-1234"
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "ux-safety-render-"))
process.env.UX_SAFETY_OUT = dist
await build({ configFile: path.join(import.meta.dir, "ux-safety.vite.config.ts") })
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright")
const shell = fs.readdirSync(cache).filter((dir) => dir.startsWith("chromium_headless_shell-")).sort().at(-1)
const executable = shell ? path.join(cache, shell, "chrome-headless-shell-mac-arm64/chrome-headless-shell") : undefined
const browser = await chromium.launch({ headless: true, executablePath: executable && fs.existsSync(executable) ? executable : undefined })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  const consoleOutput: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => consoleOutput.push(message.text()))
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== "ux-safety.local") return route.abort()
    const relative = decodeURIComponent(url.pathname).replace(/^\/+$/, "ux-safety.html").replace(/^\/+/, "")
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
    ["provider", "provider-card", '[data-scene="provider-card"]'],
    ["disconnect", "disconnect-confirm", '[data-component="dialog-v2"]'],
    ["key", "change-key", '[data-scene="change-key"]'],
    ["custom", "custom-provider", '[data-scene="custom-provider"]'],
  ] as const
  for (const [hash, name, selector] of scenes) {
    await page.goto(`http://ux-safety.local/ux-safety.html?scene=${hash}#${hash}`)
    const target = page.locator(selector)
    try {
      await target.waitFor({ state: "visible", timeout: 5000 })
    } catch {
      throw new Error(
        `Scene ${hash} did not render; title=${await page.title()}; visible text=${(await page.locator("body").innerText().catch(() => "")).slice(0, 300)}; page errors=${errors.join("; ")}; console=${consoleOutput.join("; ").slice(0, 800)}`,
      )
    }
    if (hash === "disconnect") {
      const cancel = page.locator('[data-component="dialog-v2"] button[autofocus]')
      await cancel.waitFor({ state: "visible" })
      if (!(await cancel.innerText()).includes("Batal")) throw new Error("Disconnect confirmation did not focus Cancel")
      const destructive = page.locator('[data-component="dialog-v2"] button[data-variant="danger"]')
      if (!(await destructive.innerText()).includes("Putuskan")) throw new Error("Disconnect action is not styled as destructive")
    }
    if (hash === "key" || hash === "custom") {
      const fields = target.locator('input[name="apiKey"]')
      const count = await fields.count()
      if (count !== 1) throw new Error(`${name} should render one masked fake credential, found ${count}`)
      const field = fields.first()
      if ((await field.getAttribute("type")) !== "password") throw new Error(`${name} credential is not masked by default`)
      if ((await field.getAttribute("autocomplete")) !== "off" || (await field.getAttribute("spellcheck")) !== "false") {
        throw new Error(`${name} credential field is missing autocomplete/spellcheck protections`)
      }
      await target.locator('button[aria-pressed="false"]').first().click()
      if ((await field.getAttribute("type")) !== "text") throw new Error(`${name} eye button did not reveal the credential`)
      await target.locator('button[aria-pressed="true"]').first().click()
      if ((await field.getAttribute("type")) !== "password") throw new Error(`${name} eye button did not re-mask the credential`)
    }
    if ((await page.locator("body").innerText()).includes(fakeKey)) throw new Error("A fake API key appeared in visible page text")
    for (const scheme of ["light", "dark"] as const) {
      await page.locator("html").evaluate((element, value) => {
        ;(element as HTMLHtmlElement).dataset.colorScheme = value
      }, scheme)
      await target.screenshot({ path: path.join(out, `${name}-id-${scheme}.png`) })
    }
    if (hash === "disconnect") {
      await page.keyboard.press("Escape")
      await page.locator('[data-component="dialog-v2"]').waitFor({ state: "hidden" })
      if ((await page.locator("body").getAttribute("data-disconnect-confirmed")) !== "false") {
        throw new Error("Escape did not cancel the disconnect action")
      }
    }
  }
  if (errors.length) throw new Error(`Headless render errors: ${errors.join("; ")}`)
  if (consoleOutput.some((line) => line.includes(fakeKey))) throw new Error("A fake API key appeared in console output")
} finally {
  await browser.close()
  fs.rmSync(dist, { recursive: true, force: true })
}
console.log(`ID light/dark UX safety screenshots saved to ${out}`)
