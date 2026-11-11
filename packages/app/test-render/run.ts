// Headless render check for the U5 desktop pieces: vite build -> headless Chromium (no window) -> asserts + screenshots.
// Usage: bun test-render/run.ts <screenshot-dir>   (needs the Playwright Chromium headless shell in ~/Library/Caches/ms-playwright)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { build } from "vite"
import { chromium } from "@playwright/test"

const out = path.resolve(process.argv[2] ?? "screenshots")
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "u5-render-"))
process.env.U5_OUT = dist
await build({ configFile: path.join(import.meta.dir, "vite.config.ts") })

const server = http.createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+$/, "index.html"))
  fs.readFile(file, (err, data) => {
    if (err) return void res.writeHead(404).end()
    const ext = path.extname(file)
    res.writeHead(200, { "content-type": ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".html" ? "text/html" : "application/octet-stream" }).end(data)
  })
})
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
const port = (server.address() as { port: number }).port

const cache = path.join(os.homedir(), "Library/Caches/ms-playwright")
const shell = fs.readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().at(-1)
const exe = shell ? path.join(cache, shell, "chrome-headless-shell-mac-arm64/chrome-headless-shell") : undefined
const browser = await chromium.launch({ headless: true, executablePath: exe && fs.existsSync(exe) ? exe : undefined })
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`http://127.0.0.1:${port}/index.html`)
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true)
  check(await page.locator("section[data-lang=en] [data-component=ezk-usage]").first().isVisible(), "sidebar blocks are visible at desktop width")
  check(errors.length === 0, `no page errors ${errors.join("; ")}`)
  const text = async (lang: string, sel = "") => (await page.locator(`section[data-lang=${lang}] ${sel}`).first().innerText()).replace(/\s+/g, " ")

  const enChips = await page.locator("section[data-lang=en] [data-component=ezk-chips]").first().innerText()
  check(/Auto-edit/.test(enChips) && /Trusted folder/.test(enChips) && /Sandbox on/.test(enChips) && /Web search on/.test(enChips), "EN chips: mode, trust, sandbox on, web search")
  const idChips = await page.locator("section[data-lang=id] [data-component=ezk-chips]").first().innerText()
  check(/Edit otomatis/.test(idChips) && /Folder dipercaya/.test(idChips) && /Sandbox aktif/.test(idChips) && /Pencarian web aktif/.test(idChips), "ID chips")
  const risky = await page.locator("section[data-lang=en] [data-component=ezk-chips]").nth(1).innerText()
  check(/Folder not trusted/.test(risky) && /Sandbox off/.test(risky) && !/Web search/.test(risky), "EN risky chips: not trusted, sandbox off, no web chip")
  const usage = await page.locator("section[data-lang=en] [data-component=ezk-usage]").first().innerText()
  check(/\$0\.0042/.test(usage) && !/\$0\.00\s*$/.test(usage), "cost shows the real value, not the $0.00 placeholder")
  check(/Cache hits\s*92%/.test(usage), "cache hit 92%")
  check(/10% of 128k/.test(usage), "context 10% of 128k")
  check(/41k in · 1\.4k out/.test(usage), "tokens shown")
  const usageId = await page.locator("section[data-lang=id] [data-component=ezk-usage]").first().innerText()
  check(/Biaya/.test(usageId) && /Cache terpakai/.test(usageId) && /Konteks terpakai/.test(usageId), "ID usage labels")
  check(/Send a message to see cost and tokens/.test(await page.locator("section[data-lang=en] [data-component=ezk-usage]").nth(1).innerText()), "empty state")
  check((await page.locator("section[data-lang=en] [data-task]").count()) === 3, "3 task rows")
  const tasks = await text("en", "[data-slot=tasks]")
  check(/bun run dev --port 5173/.test(tasks) && /Running for 2m 05s/.test(tasks) && /VITE v6 ready/.test(tasks), "running task: command, runtime, last lines")
  check(/Finished \(0\)/.test(tasks) && /Stopped \(\?\)/.test(tasks), "finished and stopped states")
  check((await page.locator("section[data-lang=en] [data-task=bg_1] button").count()) === 2, "running task has Show output + Stop")
  check((await page.locator("section[data-lang=en] [data-task=bg_2] button").count()) === 1, "finished task has only Show output")
  check(/Berjalan 2m 05s/.test(await text("id", "[data-slot=tasks]")), "ID runtime")

  fs.mkdirSync(out, { recursive: true })
  await page.locator("section[data-lang=en]").screenshot({ path: path.join(out, "sidebar-status-en.png") })
  await page.locator("section[data-lang=id]").screenshot({ path: path.join(out, "sidebar-status-id.png") })
  await page.locator("section[data-lang=en] [data-task=bg_1] button").first().click()
  check(/line 2/.test(await text("en", "[data-task=bg_1]")), "Show output reveals the output")
  await page.locator("section[data-lang=en] [data-slot=tasks]").screenshot({ path: path.join(out, "tasks-output-open-en.png") })
} finally {
  await browser.close()
  server.close()
  fs.rmSync(dist, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("all render checks passed")
