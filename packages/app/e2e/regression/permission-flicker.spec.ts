import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

// Ezkielyna Agent regression (ezk.8): two permission requests in a row (bash, then external_directory) made the inline
// permission card and the composer's permission dock flicker in turn, and for a while both were shown together.
// The inline card and the dock are two renderings of the same request; at any frame exactly one of them must exist.

const directory = "C:/OpenCode/PermissionFlicker"
const projectID = "proj_permission_flicker"
const sessionID = "ses_permission_flicker"
const title = "Permission flicker regression"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

const inline = '[data-component="session-permission-inline"]'
const dock = '[data-component="dock-prompt"][data-kind="permission"]'

type Sample = { inline: number; dock: number }

/** Count both permission prompts on every animation frame for `frames` frames. */
async function sampleFrames(page: Page, frames: number): Promise<Sample[]> {
  return page.evaluate(
    ({ inline, dock, frames }) =>
      new Promise<Sample[]>((resolve) => {
        const out: Sample[] = []
        const tick = () => {
          out.push({
            inline: document.querySelectorAll(inline).length,
            dock: document.querySelectorAll(dock).length,
          })
          if (out.length < frames) requestAnimationFrame(tick)
          else resolve(out)
        }
        requestAnimationFrame(tick)
      }),
    { inline, dock, frames },
  )
}

function expectExactlyOnePrompt(samples: Sample[], label: string) {
  const bad = samples.filter((s) => s.inline + s.dock !== 1)
  expect(
    bad,
    `${label}: frames with != 1 permission prompt: ${JSON.stringify(bad)} of ${JSON.stringify(samples)}`,
  ).toEqual([])
  const toggles = samples.filter((s, i) => i > 0 && s.inline !== samples[i - 1].inline).length
  expect(toggles, `${label}: the inline card toggled ${toggles}x within one request: ${JSON.stringify(samples)}`).toBe(
    0,
  )
}

const request = (id: string, permission: string, patterns: string[]) => ({
  id,
  sessionID,
  permission,
  patterns,
  metadata: {},
  always: [],
  tool: { messageID: `message-${id}`, callID: `call-${id}` },
})

test("two permission requests in a row show exactly one prompt per frame", async ({ page }) => {
  const transport = await installSseTransport(page, { server, retry: 20 })
  let pending: unknown[] = [request("perm-bash", "bash", ["python3 hello.py"])]
  await mockServer(page, () => pending)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  // First request: the inline card is in the timeline, the dock stays hidden.
  await expect(page.locator(inline)).toHaveCount(1)
  expectExactlyOnePrompt(await sampleFrames(page, 60), "request A settled")

  // The agent answers A and immediately asks B (what `bash` followed by `external_directory` does).
  pending = [request("perm-dir", "external_directory", ["/Users/alice/Documents"])]
  await transport.burst([
    {
      directory,
      payload: { type: "permission.replied", properties: { sessionID, requestID: "perm-bash", reply: "once" } },
    },
    { directory, payload: { type: "permission.asked", properties: pending[0] } },
  ])
  await expect(page.locator(inline).getByText("/Users/alice/Documents")).toBeVisible()
  expectExactlyOnePrompt(await sampleFrames(page, 60), "request B settled")

  // Answering B through the card removes every prompt (v1 reply route: POST /session/:id/permissions/:requestID).
  const reply = page.waitForRequest(
    (req) => req.method() === "POST" && new URL(req.url()).pathname === `/session/${sessionID}/permissions/perm-dir`,
  )
  await page
    .locator(inline)
    .getByRole("button", { name: /Allow once|Izinkan sekali/ })
    .click()
  expect((await reply).postDataJSON()).toMatchObject({ response: "once" })
  pending = []
  await transport.send({
    directory,
    payload: { type: "permission.replied", properties: { sessionID, requestID: "perm-dir", reply: "once" } },
  })
  await expect(page.locator(inline)).toHaveCount(0)
  await expect(page.locator(dock)).toHaveCount(0)
})

test("the dock never shows while the active request's card is mounted, across A -> B -> C", async ({ page }) => {
  const transport = await installSseTransport(page, { server, retry: 20 })
  let pending: unknown[] = [request("perm-1", "bash", ["ls"])]
  await mockServer(page, () => pending)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)
  await expect(page.locator(inline)).toHaveCount(1)

  for (const [prev, next] of [
    ["perm-1", "perm-2"],
    ["perm-2", "perm-3"],
  ] as const) {
    pending = [request(next, "edit", [`${next}.txt`])]
    await transport.burst([
      { directory, payload: { type: "permission.replied", properties: { sessionID, requestID: prev, reply: "once" } } },
      { directory, payload: { type: "permission.asked", properties: pending[0] } },
    ])
    await expect(page.locator(inline).getByText(`${next}.txt`)).toBeVisible()
    expectExactlyOnePrompt(await sampleFrames(page, 45), `${prev} -> ${next}`)
  }
})

// Protocol v1: the fork's server speaks v1 only, and under v2 the app normalises every provider to `source: "custom"`
// without a key, so the first-run "Connect Ezkielyna" modal would open and intercept every click.
async function mockServer(page: Page, permissions: () => unknown[]) {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "permission-flicker",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "permission-flicker",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    permissions,
    questions: [],
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: true, shouldDisplayTabsToast: false } }),
    )
  })
}
