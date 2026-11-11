import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { chromium } from "@playwright/test"

const out = path.resolve(process.argv[2] ?? "docs/v3/screenshots/bugreport")
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "bugreport-render-"))
process.env.BUGREPORT_OUT = dist
await build({ configFile: path.join(import.meta.dir, "bugreport.vite.config.ts") })
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright")
const shell = fs.readdirSync(cache).filter((dir) => dir.startsWith("chromium_headless_shell-")).sort().at(-1)
const executable = shell ? path.join(cache, shell, "chrome-headless-shell-mac-arm64/chrome-headless-shell") : undefined
const browser = await chromium.launch({ headless: true, executablePath: executable && fs.existsSync(executable) ? executable : undefined })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== "bugreport.local") return route.abort()
    const relative = decodeURIComponent(url.pathname).replace(/^\/+$/, "bugreport.html").replace(/^\/+/, "")
    const root = path.resolve(dist)
    const file = path.resolve(root, relative)
    if (!file.startsWith(`${root}${path.sep}`) && file !== root) return route.fulfill({ status: 404 })
    try {
      const body = await fs.promises.readFile(file)
      const ext = path.extname(file)
      const contentType = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".woff2" ? "font/woff2" : ext === ".ttf" ? "font/ttf" : "application/octet-stream"
      return route.fulfill({ status: 200, contentType, body })
    } catch {
      return route.fulfill({ status: 404 })
    }
  })
  await page.goto("http://bugreport.local/bugreport.html")
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true)
  await page.locator('[data-component="ezk-bugreport-dialog"]').waitFor({ state: "visible" })
  await page.getByRole("button", { name: "Buka grup WhatsApp" }).waitFor({ state: "visible" })
  if (errors.length) throw new Error(`Headless render errors: ${errors.join("; ")}`)
  const report = page.locator('[data-component="ezk-bugreport-dialog"] textarea')
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLTextAreaElement>('[data-component="ezk-bugreport-dialog"] textarea')
    return !!element?.value.includes("Laporan masalah Ezkielyna Agent")
  })
  await page.getByText("Menyiapkan laporan…", { exact: true }).waitFor({ state: "hidden" })
  if (!(await report.evaluate((element) => (element as HTMLTextAreaElement).readOnly))) throw new Error("report text is editable")
  if (!(await page.locator('[data-component="ezk-bugreport-dialog"]').innerText()).includes("Jangan tempel API key"))
    throw new Error("the API key reminder is missing")
  const outDir = path.resolve(out)
  fs.mkdirSync(outDir, { recursive: true })
  for (const scheme of ["light", "dark"] as const) {
    await page.locator("html").evaluate((element, value) => {
      ;(element as HTMLHtmlElement).dataset.colorScheme = value
    }, scheme)
    await page.locator('[data-component="ezk-bugreport-dialog"]').screenshot({
      path: path.join(outDir, `bugreport-dialog-id-${scheme}.png`),
    })
  }
  await page.getByRole("button", { name: "Salin" }).click()
  await page.getByRole("button", { name: "Simpan file" }).click()
  await page.getByRole("button", { name: "Buka grup WhatsApp" }).click()
  const actions = await page.evaluate(() => (window as unknown as { bugReportActions: { copied: string[]; saved: string[]; opened: string[] } }).bugReportActions)
  if (actions.copied[0] !== (await report.inputValue())) throw new Error("copy action did not use the displayed report")
  if (actions.saved[0] !== (await report.inputValue())) throw new Error("save action did not use the displayed report")
  if (actions.opened[0] !== "https://chat.whatsapp.com/L6igdMdMsuz4eAdKe6jHUC") throw new Error("support group did not open through the platform")
} finally {
  await browser.close()
  fs.rmSync(dist, { recursive: true, force: true })
}
console.log(`Indonesian light/dark report dialog screenshots saved to ${path.resolve(out)}`)
