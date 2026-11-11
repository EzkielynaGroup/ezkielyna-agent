// Headless visual check for Lane P1. Keep the process foreground under .heavy.lock.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { chromium } from "@playwright/test"

const out = path.resolve(process.argv[2] ?? "docs/v3/screenshots/polish-shell")
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "polish-shell-render-"))
process.env.U5_OUT = dist
await build({ configFile: path.join(import.meta.dir, "polish-shell.vite.config.ts") })
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
const failures: string[] = []
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`)
  if (!ok) failures.push(label)
}

try {
  fs.mkdirSync(out, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  await page.route("http://polish-shell.test/**", async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname)
    const relative = pathname === "/" ? "polish-shell.html" : pathname.slice(1)
    const file = path.resolve(dist, relative)
    if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) {
      await route.fulfill({ status: 403, body: "forbidden" })
      return
    }
    try {
      const body = await fs.promises.readFile(file)
      const contentType = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".woff2")
            ? "font/woff2"
            : file.endsWith(".ttf")
              ? "font/ttf"
              : file.endsWith(".svg")
                ? "image/svg+xml"
                : "text/html"
      await route.fulfill({ status: 200, contentType, body })
    } catch {
      await route.fulfill({ status: 404, body: "not found" })
    }
  })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  for (const screen of ["home", "first-run", "providers", "states"] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.goto(`http://polish-shell.test/polish-shell.html?screen=${screen}&theme=${theme}&lang=id`)
      try {
        await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, undefined, {
          timeout: 8_000,
        })
      } catch {
        throw new Error(
          `fixture did not become ready for ${screen}/${theme}; errors: ${errors.join("; ")}; body: ${await page.locator("body").innerText()}`,
        )
      }
      const root = page.locator(`[data-shot="${screen}"]`)
      check(await root.isVisible(), `${screen} ${theme} renders`)
      const bg = await page
        .locator("html")
        .evaluate((el) => getComputedStyle(el).getPropertyValue("--v2-background-bg-deep").trim())
      check(
        theme === "light" ? bg === "#faf8f4" : bg === "#181715",
        `${screen} ${theme} uses the store canvas token (${bg})`,
      )
      if (screen === "home") {
        check(
          (await root.locator("h1").innerText()) === "Mau dikerjakan apa hari ini?",
          "home headline is the approved Indonesian copy",
        )
        check((await root.locator(".ezk-home-suggestion").count()) === 4, "home has four selectable suggestions")
        check(
          (await root.locator('.polish-send use').getAttribute("href")) === "#opencode-v2-icon-arrow-up",
          "home send control uses the up-arrow glyph",
        )
        const sendShape = await root.locator(".polish-send").evaluate((el) => {
          const style = getComputedStyle(el)
          return {
            radius: style.borderTopLeftRadius,
            width: Number.parseFloat(style.width),
            height: Number.parseFloat(style.height),
            background: style.backgroundColor,
          }
        })
        check(
          (sendShape.radius === "50%" || Number.parseFloat(sendShape.radius) >= Math.min(sendShape.width, sendShape.height) / 2) &&
            sendShape.background !== "rgba(0, 0, 0, 0)",
          `home send control is a filled circle (${JSON.stringify(sendShape)})`,
        )
        check(
          (await root.locator('[aria-label="Lampirkan file"] use').getAttribute("href")) ===
            "#opencode-v2-icon-paperclip",
          "home attach control uses a paperclip",
        )
        check(
          (await root.locator(".polish-project-row").count()) === 3 &&
            (await root.locator(".polish-project-row").first().evaluate((el) => getComputedStyle(el).alignItems)) ===
              "center" &&
            (await root.locator(".polish-project-row").first().locator("svg").count()) === 2,
          "project folder, name and expand chevron stay on one row",
        )
        check(
          (await root.getByTestId("home-keyboard-hints").getAttribute("aria-label")) ===
            "↵ kirim · ⇧↵ baris baru · / perintah",
          "home shows the requested right-side keyboard hints",
        )
        const hintsLayout = await root.getByTestId("home-keyboard-hints").evaluate((el) => {
          const style = getComputedStyle(el)
          return {
            display: style.display,
            direction: style.flexDirection,
            wrapping: style.flexWrap,
          }
        })
        check(
          (await root.getByTestId("home-keyboard-hints").isVisible()) &&
            hintsLayout.display.endsWith("flex") &&
            hintsLayout.direction === "row" &&
            hintsLayout.wrapping === "nowrap",
          `keyboard hints are visibly laid out in one row (${JSON.stringify(hintsLayout)})`,
        )
        check(
          (await root.locator(".ezk-key-group-value").innerText()) === "Auto · semua model",
          "sidebar key group is displayed as the terracotta pill",
        )
        check((await root.locator(".ezk-sidebar [data-slot=icon-svg]").first().getAttribute("aria-hidden")) === "true", "sidebar icons remain decorative")
        check(
          (await root.getByRole("button", { name: "Memori" }).locator("use").getAttribute("href")) ===
            "#opencode-icon-brain",
          "Memory navigation uses the brain icon",
        )
        check(
          (await root.locator(".ezk-key-group-value").evaluate((el) => getComputedStyle(el).borderRadius)) ===
            "999px",
          "sidebar key group value is pill-shaped",
        )
        check(
          JSON.stringify(await root.locator(".ezk-home-suggestion-icon use").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")))) ===
            JSON.stringify([
              "#opencode-v2-icon-bug",
              "#opencode-v2-icon-flask",
              "#opencode-v2-icon-code",
              "#opencode-v2-icon-wand",
            ]),
          "suggestion cards use the mockup icons inside their icon tiles",
        )
        check(
          (await root.getByText("Local/Cloud", { exact: true }).count()) === 0,
          "home does not show a Local/Cloud switch",
        )
        check(
          (await root.locator('[data-component="ezk-test-profile-badge"]').count()) === 0,
          "normal profile does not show a test-profile badge",
        )
      }
      if (screen === "first-run")
        check(
          (await root.locator('input[name="apiKey"]').getAttribute("type")) === "password" &&
            (await root.locator('input[name="apiKey"]').inputValue()) === "",
          "first-run key starts empty and masked",
        )
      if (screen === "providers")
        check(
          (await root.locator("[data-component=ezk-provider-card]").innerText()).includes("sk-••••a9F2"),
          "provider card uses a masked mock key",
        )
      if (screen === "providers")
        check(
          (await root.locator(".ezk-key-group-value").count()) === 2 &&
            (await root.locator(".ezk-key-group-value").last().innerText()) === "Auto · semua model",
          "Providers sidebar keeps the key-group pill",
        )
      if (screen === "states") {
        const errorToast = page.locator(".toast-v2-region .toast-v2--error")
        const expectedError = "Permintaan gagal"
        await errorToast.waitFor({ state: "visible" })
        check(
          (await root.locator("[data-component=empty-state-v2]").count()) === 2,
          "shared empty state renders in both sizes",
        )
        check((await page.locator('.toast-v2[role="status"]').count()) > 0, "success toast uses role=status")
        check((await page.locator('.toast-v2[role="alert"]').count()) > 0, "error toast uses role=alert")
        check((await errorToast.innerText()).includes(expectedError), "ID error toast is translated")
      }
      if (screen === "states") await page.screenshot({ path: path.join(out, `${screen}-id-${theme}.png`) })
      else await root.screenshot({ path: path.join(out, `${screen}-id-${theme}.png`) })
    }
  }
  await page.goto(`http://polish-shell.test/polish-shell.html?screen=home&theme=light&lang=en`)
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true)
  check(
    (await page.locator("[data-shot=home] h1").innerText()) === "What should we work on today?",
    "English home headline is translated",
  )
  await page.locator("[data-shot=home] .ezk-home-suggestion").first().click()
  check(
    (await page.locator("[data-shot=home] output").getAttribute("data-picked")) === "code",
    "suggestion click fills the selected prompt type",
  )
  await page.goto("http://polish-shell.test/polish-shell.html?screen=counter-accessibility&theme=light&lang=id")
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true)
  check(
    (await page.getByRole("button", { name: /Selesai menjelajah.*1 pembacaan.*1 pencarian.*1 daftar/ }).count()) === 1,
    "tool-count summary exposes the real value in its accessible name",
  )
  check((await page.locator('[data-component="tool-count-summary"]').count()) === 1, "tool-count consumer renders")
  check((await page.locator('[data-component="session-todo-dock"]').isVisible()), "todo dock consumer renders")
  check(
    (await page.locator('[data-slot="animated-number-value"][aria-hidden="true"]').count()) === 5,
    "all tool-summary and todo-dock rolling number strips are hidden from assistive technology",
  )
  check(
    (await page.getByRole("button", { name: /1 dari 2 tugas selesai/ }).count()) === 1,
    "todo dock progress remains in the accessible name",
  )
  await page.goto("http://polish-shell.test/polish-shell.html?screen=home&theme=light&lang=id&profile=test")
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true)
  const testBadges = page.locator('[data-component="ezk-test-profile-badge"]')
  check((await testBadges.count()) === 2, "test profile badge appears in the titlebar and sidebar")
  check((await testBadges.first().innerText()) === "Profil uji", "test profile badge is localized")
  check((await testBadges.first().getAttribute("title")) === "Host API: localhost:4310", "badge hover shows only the API host")
  check(errors.length === 0, `no browser errors (${errors.join("; ")})`)
} finally {
  await browser.close()
  fs.rmSync(dist, { recursive: true, force: true })
}
if (failures.length) process.exit(1)
console.log(`Headless light/dark screenshots saved to ${out}`)
