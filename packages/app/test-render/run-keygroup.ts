import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { build } from "vite"
import { chromium } from "@playwright/test"

const out = path.resolve(process.argv[2] ?? "docs/v3/screenshots/keygroup")
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "keygroup-render-"))
process.env.U5_OUT = dist
await build({ configFile: path.join(import.meta.dir, "keygroup.vite.config.ts") })
const server = http.createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+$/, "keygroup.html")
  fs.readFile(path.join(dist, name), (error, data) => {
    if (error) return void res.writeHead(404).end()
    const ext = path.extname(name)
    res
      .writeHead(200, { "content-type": ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html" })
      .end(data)
  })
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = (server.address() as { port: number }).port
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright")
const shell = fs
  .readdirSync(cache)
  .filter((dir) => dir.startsWith("chromium_headless_shell-"))
  .sort()
  .at(-1)
const executablePath = shell
  ? path.join(cache, shell, "chrome-headless-shell-mac-arm64/chrome-headless-shell")
  : undefined
const browser = await chromium.launch({
  headless: true,
  executablePath: executablePath && fs.existsSync(executablePath) ? executablePath : undefined,
})

try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 1120 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await page.goto(`http://127.0.0.1:${port}/keygroup.html`)
  try {
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, undefined, {
      timeout: 10_000,
    })
  } catch {
    throw new Error(
      `render did not become ready; page errors: ${errors.join("; ")}; body: ${await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable")}`,
    )
  }
  if (errors.length) throw new Error(`headless render errors: ${errors.join("; ")}`)
  if (!(await page.locator("[data-slot=key-group-summary]").first().isVisible()))
    throw new Error("key group summary is missing")
  if (!(await page.locator("[data-slot=key-group-tip]").first().isVisible()))
    throw new Error("small-catalog tip is missing")

  fs.mkdirSync(out, { recursive: true })
  for (const view of ["account", "model"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      await page.locator("html").evaluate((element, colorScheme) => {
        ;(element as HTMLHtmlElement).dataset.colorScheme = colorScheme
      }, scheme)
      await page
        .locator(`[data-view=${view}-${scheme}] [data-scene=${view === "account" ? "account-card" : "model-dialog"}]`)
        .screenshot({
          path: path.join(out, `${view === "account" ? "account-card" : "model-dialog"}-id-${scheme}.png`),
        })
    }
  }
} finally {
  await browser.close()
  server.close()
  fs.rmSync(dist, { recursive: true, force: true })
}

console.log(`Headless Indonesian light/dark screenshots saved to ${out}`)
