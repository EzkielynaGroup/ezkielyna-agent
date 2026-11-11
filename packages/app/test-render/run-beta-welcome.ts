import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { chromium } from "@playwright/test"

const out = path.resolve(process.argv[2] ?? "../../docs/v3/screenshots/betawelcome")
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "beta-welcome-render-"))
process.env.BETA_WELCOME_OUT = dist
await build({ configFile: path.join(import.meta.dir, "beta-welcome.vite.config.ts") })
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright")
const shell = fs.readdirSync(cache).filter((dir) => dir.startsWith("chromium_headless_shell-")).sort().at(-1)
const executable = shell ? path.join(cache, shell, "chrome-headless-shell-mac-arm64/chrome-headless-shell") : undefined
const browser = await chromium.launch({ headless: true, executablePath: executable && fs.existsSync(executable) ? executable : undefined })
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`)
  })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== "beta-welcome.local") return route.abort()
    const relative = decodeURIComponent(url.pathname).replace(/^\/+$/, "beta-welcome.html").replace(/^\/+/, "")
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
  await page.goto("http://beta-welcome.local/beta-welcome.html#card")
  const card = page.locator('[data-component="ezk-beta-welcome-card"]')
  try {
    await card.waitFor({ state: "visible", timeout: 5000 })
  } catch {
    throw new Error(`welcome card did not render; body=${await page.locator("body").innerText()}; errors=${errors.join("; ")}`)
  }
  const cardText = await card.innerText()
  check(cardText.includes("Ezkielyna Agent Beta: versi 1.19.3-ezk.5") && cardText.includes("Apa yang baru"), "welcome card renders in Indonesian")
  check(cardText.includes("Jalankan test") && cardText.includes("Grup diskusi WhatsApp") && cardText.includes("Cek kesehatan"), "welcome actions and onboarding copy are present")
  for (const scheme of ["light", "dark"] as const) {
    await page.locator("html").evaluate((element, value) => {
      ;(element as HTMLHtmlElement).dataset.colorScheme = value
    }, scheme)
    await card.screenshot({ path: path.join(out, `welcome-card-id-${scheme}.png`) })
  }

  await page.goto("http://beta-welcome.local/beta-welcome.html?scene=health#health")
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true)
  const health = page.locator('[data-component="ezk-beta-health-dialog"]')
  try {
    await health.waitFor({ state: "visible", timeout: 5000 })
  } catch {
    throw new Error(`health dialog did not render; body=${await page.locator("body").innerText()}; errors=${errors.join("; ")}`)
  }
  check((await page.locator('[role="dialog"]').innerText()).includes("Cek kesehatan saat pertama dibuka"), "checklist title renders in Indonesian")
  const healthDialog = page.locator('[role="dialog"]')
  check((await health.locator("[class*=grid-cols]").count()) === 5, "checklist shows key, connection, group, disk and trust")
  for (const scheme of ["light", "dark"] as const) {
    await page.locator("html").evaluate((element, value) => {
      ;(element as HTMLHtmlElement).dataset.colorScheme = value
    }, scheme)
    await healthDialog.screenshot({ path: path.join(out, `health-check-id-${scheme}.png`) })
  }
  check(errors.length === 0, `no page errors ${errors.join("; ")}`)
} finally {
  await browser.close()
  fs.rmSync(dist, { recursive: true, force: true })
}
if (failures.length) throw new Error(`${failures.length} beta welcome render check(s) failed`)
console.log(`ID light/dark beta welcome screenshots saved to ${out}`)
