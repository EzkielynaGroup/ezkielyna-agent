import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { buildInitialStreamEvent, setupTimelineBenchmark } from "./session-timeline-benchmark.fixture"

const output = resolve(
  process.env.POLISH_MERGE_SCREENSHOT_DIR ?? resolve(process.cwd(), "../../docs/v3/screenshots/polish-merge"),
)
const themes = ["light", "dark"] as const
const screenshotViewport = { width: 1280, height: 900 }

async function expectAaContrast(page: import("@playwright/test").Page, selector: string, label: string) {
  const audit = await page.locator(selector).evaluateAll((roots) => {
    const parse = (value: string) => {
      const numbers = value.match(/[\d.]+/g)?.map(Number)
      if (!numbers || numbers.length < 3) return
      return [numbers[0], numbers[1], numbers[2], numbers[3] ?? 1] as const
    }
    const composite = (foreground: readonly number[], background: readonly number[]) => {
      const alpha = foreground[3] ?? 1
      return [0, 1, 2].map((index) => foreground[index] * alpha + background[index] * (1 - alpha))
    }
    const luminance = (rgb: readonly number[]) => {
      const channels = rgb.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    }
    const ratio = (foreground: readonly number[], background: readonly number[]) => {
      const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
      return (light + 0.05) / (dark + 0.05)
    }
    const visible = (element: Element) => {
      const style = getComputedStyle(element)
      return (
        element.getClientRects().length > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        !element.closest('[aria-hidden="true"]')
      )
    }
    const backgroundFor = (element: Element) => {
      const ancestry: Element[] = []
      for (let current: Element | null = element; current; current = current.parentElement) ancestry.push(current)
      let background: number[] = [255, 255, 255]
      for (const current of ancestry.reverse()) {
        const color = parse(getComputedStyle(current).backgroundColor)
        if (color && color[3] > 0) background = composite(color, background)
      }
      return background
    }
    const textNodes = roots.flatMap((root) => [root, ...root.querySelectorAll("*")])
    const samples = [...new Set(textNodes)]
      .filter(visible)
      .flatMap((element) => {
        const text = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .trim()
        if (!text) return []
        const style = getComputedStyle(element)
        const foreground = parse(style.color)
        if (!foreground) return []
        const background = backgroundFor(element)
        const effectiveForeground = composite(foreground, background)
        const size = Number.parseFloat(style.fontSize)
        const weight = Number.parseInt(style.fontWeight, 10)
        const threshold = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5
        const contrast = ratio(effectiveForeground, background)
        return [
          {
            text: text.slice(0, 80),
            className: element.getAttribute("class") ?? element.tagName.toLowerCase(),
            foreground: style.color,
            background: getComputedStyle(element).backgroundColor,
            contrast,
            threshold,
          },
        ]
      })
    const graphics = roots
      .flatMap((root) => [root, ...root.querySelectorAll(".session-polish-permission-icon")])
      .filter((element) => element.matches(".session-polish-permission-icon") && visible(element))
      .map((element) => {
        const foreground = parse(getComputedStyle(element).color)
        const background = parse(getComputedStyle(element).backgroundColor)
        const contrast = foreground && background ? ratio(composite(foreground, background), background) : 0
        return { contrast, threshold: 3 }
      })
    return {
      samples,
      graphics,
      failures: samples.filter((sample) => sample.contrast + 0.01 < sample.threshold),
      graphicFailures: graphics.filter((sample) => sample.contrast + 0.01 < sample.threshold),
    }
  })
  const minimum = Math.min(...audit.samples.map((sample) => sample.contrast))
  console.info(`${label}: ${audit.samples.length} text runs; minimum contrast ${minimum.toFixed(2)}:1`)
  expect(audit.samples.length, `${label} should include visible text`).toBeGreaterThan(0)
  expect(audit.failures, `${label} should meet WCAG AA text contrast`).toEqual([])
  expect(audit.graphicFailures, `${label} graphics should meet WCAG contrast`).toEqual([])
}

async function dismissTabIntro(page: import("@playwright/test").Page) {
  const dismiss = page.getByRole("button", { name: /Dismiss Tabs information|Tutup informasi tentang Tab/ })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
}

function streamEvent(text: string) {
  const event = buildInitialStreamEvent(1)
  const part = event.payload.properties.part as { type?: string; text?: string }
  if (part.type === "text") part.text = text
  return event
}

const testPart = {
  id: "prt_0004_test",
  sessionID: "ses_timeline_state_regression",
  messageID: "msg_assistant_regression",
  type: "tool",
  callID: "call_test_regression",
  tool: "bash",
  state: {
    status: "completed",
    input: { command: "npm test" },
    output: "Tests 24 passed",
    title: "npm test",
    metadata: { exit: 0 },
    time: { start: 1700000003000, end: 1700000007200 },
  },
}
const readParts = [
  { id: "prt_0000_read_checkout", tool: "read", input: { filePath: "src/payment/checkout.ts" } },
  { id: "prt_0000_read_coupon", tool: "read", input: { filePath: "src/payment/coupon.ts" } },
  { id: "prt_0000_read_test", tool: "grep", input: { path: "src/payment/checkout.test.ts", pattern: "checkout" } },
].map((part) => ({
  ...part,
  sessionID: "ses_timeline_state_regression",
  messageID: "msg_assistant_regression",
  type: "tool",
  callID: `call_${part.id}`,
  state: {
    status: "completed",
    input: part.input,
    output: "",
    title: part.tool,
    metadata: {},
    time: { start: 1700000001000, end: 1700000001500 },
  },
}))
const newFilePart = {
  id: "prt_0003_write_test",
  sessionID: "ses_timeline_state_regression",
  messageID: "msg_assistant_regression",
  type: "tool",
  callID: "call_write_test",
  tool: "write",
  state: {
    status: "completed",
    input: { filePath: "src/payment/checkout.test.ts" },
    output: "Created src/payment/checkout.test.ts",
    title: "src/payment/checkout.test.ts",
    metadata: {
      filediff: {
        file: "src/payment/checkout.test.ts",
        additions: 18,
        deletions: 0,
        before: "",
        after: "test('checkout clamps negative amounts', () => {})\n",
      },
    },
    time: { start: 1700000002000, end: 1700000003000 },
  },
}
const pendingTestPart = {
  ...testPart,
  state: {
    status: "running",
    input: { command: "npm test" },
    title: "npm test",
    time: { start: 1700000003000 },
  },
}

for (const theme of themes) {
  test(`captures the completed session in ${theme}`, async ({ page }) => {
    await mkdir(output, { recursive: true })
    const fixture = await setupTimelineBenchmark(page, {
      historyTurns: 0,
      eventBatch: 1,
      newLayoutDesigns: true,
      agents: [{ name: "build", mode: "primary" }, { name: "plan", mode: "primary" }],
      account: { state: "missing" },
      composerModel: { providerID: "ezkielyna", modelID: "default-model" },
      turnDiffs: [
        {
          file: "src/payment/checkout.ts",
          patch: "@@ -1 +1 @@\n-export const checkout = (amount: number) => amount\n+export const checkout = (amount: number) => Math.max(0, amount)",
          additions: 12,
          deletions: 3,
          status: "modified",
        },
        {
          file: "src/payment/checkout.test.ts",
          patch: "@@ -0,0 +1 @@\n+test('checkout clamps negative amounts', () => {})",
          additions: 18,
          deletions: 0,
          status: "added",
        },
      ],
      prependParts: readParts,
      extraParts: [newFilePart, testPart],
      theme,
      locale: "id",
      viewport: screenshotViewport,
    })
    await dismissTabIntro(page)
    fixture.transport.enqueue(streamEvent("Validasi selesai dan semua test lulus."))
    await expect(fixture.text).toBeVisible()
    await fixture.scrollToBottom()
    const done = page.locator(".session-polish-done")
    await expect(done).toBeVisible()
    await expect(done.getByText("Selesai", { exact: true })).toBeVisible()
    await expect(done.getByRole("button", { name: "Tinjau perubahan" })).toBeVisible()
    await expect(done.getByRole("button", { name: "Batalkan giliran ini" })).toBeVisible()
    const step = (kind: string) => page.locator(`[data-component="session-tool-steps"] [data-session-step-kind="${kind}"]`)
    await expect(step("read")).toContainText("Membaca 3 file · checkout.ts · coupon.ts · checkout.test.ts")
    await expect(step("edit")).toContainText("src/payment/checkout.ts")
    await expect(step("edit").getByRole("button", { name: "Tampilkan semua" })).toBeVisible()
    await expect(step("write")).toContainText("src/payment/checkout.test.ts")
    await expect(step("write").getByRole("button", { name: "Tampilkan semua" })).toHaveCount(0)
    await expect(step("test")).toContainText("24 tes lulus")
    await expect(done.locator('[data-slot="session-done-files"]')).toContainText("FILE DIUBAH · 2")
    await expect(done.locator('[data-slot="session-done-files"]')).toContainText("src/payment/checkout.ts")
    await expect(done.locator('[data-slot="session-done-files"]')).toContainText("src/payment/checkout.test.ts")
    await expect(done.locator('[data-slot="session-done-tests"]')).toContainText("4,2 dtk")
    await expect(done.locator('[data-slot="session-done-cost"]')).toContainText("82% cache hit")
    await expect(page.locator(".session-polish-composer .ezk-plan-chip")).toBeVisible()
    await expect(page.locator('.session-polish-composer [data-action="prompt-attach"]')).toBeVisible()
    await expect(page.locator('.session-polish-composer [data-action="prompt-submit"]')).toBeVisible()
    await expect(page.locator(".session-polish-composer [data-action='prompt-model']")).toContainText("Auto")
    await expect(page.locator(".ezk-account-balance")).toHaveClass(/ezk-account-balance--status/)
    await expect(page.locator(".ezk-account-balance")).toHaveText("Saldo belum tersedia")
    await expect(page.locator(".session-polish-composer [data-component='prompt-input-v2']")).toHaveAttribute("data-dock-border-underlay", "v2")
    await expect(page.getByText("Beri arahan lanjutan atau tugas berikutnya…", { exact: true })).toBeVisible()
    await expect(page.locator('[data-component="session-run-header"] .session-polish-stat:nth-child(2) strong')).toHaveText(
      "756 token",
    )
    await expect(page.locator('[data-component="session-run-header"] .session-polish-stat-cost strong')).toHaveText("$0.01")
    await dismissTabIntro(page)
    await fixture.scroller.hover()
    await page.mouse.wheel(0, -1200)
    await expect.poll(() => fixture.scroller.evaluate((element) => element.scrollTop)).toBe(0)
    const stepKinds = await page.locator('[data-component="session-tool-steps"]').evaluateAll((roots) =>
      roots.flatMap((root) =>
        [...root.querySelectorAll<HTMLElement>("[data-session-step-kind]")].map((element) => element.dataset.sessionStepKind),
      ),
    )
    expect(stepKinds).toEqual(["read", "edit", "write", "test"])
    const headerBottom = await page.locator('[data-component="session-run-header"]').evaluate((element) =>
      element.getBoundingClientRect().bottom,
    )
    for (const kind of ["read", "edit", "write", "test"]) {
      await expect(step(kind)).toBeInViewport()
      await expect(step(kind)).toBeVisible()
      const top = await step(kind).evaluate((element) => element.getBoundingClientRect().top)
      expect(top).toBeGreaterThan(headerBottom)
    }
    await expect(done).toBeInViewport()
    await expect(page.locator(".session-polish-composer")).toBeInViewport()
    await expectAaContrast(page, "body", `session ${theme}`)
    await page.screenshot({ path: resolve(output, `02-session-${theme}.png`), scale: "device" })
  })

  test(`captures the inline permission in ${theme}`, async ({ page }) => {
    await mkdir(output, { recursive: true })
    const fixture = await setupTimelineBenchmark(page, {
      historyTurns: 0,
      eventBatch: 1,
      newLayoutDesigns: true,
      permissions: [
        {
          id: "permission-npm-test",
          sessionID: "ses_timeline_state_regression",
          permission: "bash",
          patterns: ["npm test"],
          always: ["npm test"],
          metadata: {},
          tool: { messageID: "msg_assistant_regression", callID: "call_test_regression" },
        },
      ],
      extraParts: [pendingTestPart],
      theme,
      locale: "id",
      viewport: screenshotViewport,
    })
    await dismissTabIntro(page)
    fixture.transport.enqueue(streamEvent("Menunggu hasil test setelah mendapat izin."))
    await expect(fixture.text).toBeVisible()
    await fixture.scrollToBottom()
    await expect(page.locator('[data-component="session-permission-inline"]')).toBeVisible()
    await expect(page.getByRole("button", { name: "Izinkan sekali" })).toBeVisible()
    await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
    await expect(page.locator('[data-component="prompt-input"]')).toHaveAttribute("contenteditable", "true")
    await expect(page.locator('[data-component="session-task-cost"]')).toHaveCount(0)
    await dismissTabIntro(page)
    await expectAaContrast(page, '[data-component="session-permission-inline"]', `permission ${theme}`)
    await page.screenshot({ path: resolve(output, `03-permission-${theme}.png`), scale: "device" })
    await page.locator('[data-component="prompt-input"]').fill("Lanjutkan setelah izin dijawab")
    await page.locator('[data-action="prompt-submit"]').click()
    await expect(page.getByText("Lanjutkan setelah izin dijawab", { exact: true })).toBeVisible()
  })
}
