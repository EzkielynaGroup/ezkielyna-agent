/** @jsxImportSource @opentui/solid */
// Wave B "ux" lane, TUI: the /rewind dialogs and the plan approval card rendered with the test renderer against a
// fake /ezk/ux server. The captured character frames are written to test/ezk/__frames__ as text screenshots.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, type JSX } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { eventSource, json } from "../fixture/tui-sdk"
import { doublePress } from "../../src/ezk/ux/commands"
import { planApprovalOptions, rewindMessage, rewindModeOptions } from "../../src/ezk/ux/dialogs"
import { UX_STRINGS, ut } from "../../src/ezk/ux/strings"

const FRAMES = path.join(import.meta.dir, "__frames__")
let app: Awaited<ReturnType<typeof testRender>> | undefined
let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
afterEach(async () => {
  app?.renderer.destroy()
  app = undefined
  await tmp?.[Symbol.asyncDispose]()
  tmp = undefined
})

const checkpoints = {
  checkpoints: [
    { messageID: "msg_3", snapshot: "b".repeat(40), preview: "change the login form and add a test", at: Date.UTC(2026, 9, 21, 9, 42), files: ["/p/src/login.ts", "/p/test/login.test.ts"], turns: 1 },
    { messageID: "msg_1", snapshot: "a".repeat(40), preview: "explain the project", at: Date.UTC(2026, 9, 21, 9, 30), files: ["/p/src/login.ts"], turns: 2 },
  ],
  diskBytes: 3_250_000,
  diskText: "3.1 MB",
}

function fakeServer(calls: { path: string; body?: any }[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, body })
    if (url.pathname === "/ezk/ux/checkpoints") return json(checkpoints)
    if (url.pathname === "/ezk/ux/rewind") return json({ mode: body.mode, restored: ["/p/src/login.ts"], skipped: [] })
    if (url.pathname === "/ezk/ux/plan/approve") return json({ mode: body.mode, todos: 3, forced: false, planPath: "/x/plan.md" })
    return json({})
  }) as typeof fetch
}

async function mount(view: () => JSX.Element, calls: { path: string; body?: any }[], size = { width: 90, height: 26 }) {
  tmp = await tmpdir()
  const root = tmp.path
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [{ DialogProvider, useDialog }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }, { ToastProvider }, { OpencodeKeymapProvider, registerOpencodeKeymap }, { SDKProvider }] =
    await Promise.all([
      import("../../src/ui/dialog"),
      import("../../src/context/kv"),
      import("../../src/context/theme"),
      import("../../src/config"),
      import("../../src/ui/toast"),
      import("../../src/keymap"),
      import("../../src/context/sdk"),
    ])
  function Open() {
    const dialog = useDialog()
    dialog.replace(view)
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <SDKProvider url="http://test" directory={root} events={eventSource()} fetch={fakeServer(calls)}>
                  <ToastProvider>
                    <DialogProvider>
                      <Open />
                    </DialogProvider>
                  </ToastProvider>
                </SDKProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  app = await testRender(() => <Harness />, { ...size, kittyKeyboard: true })
  return app
}

async function frame(name: string, until: (text: string) => boolean) {
  const deadline = Date.now() + 3000
  let text = ""
  while (Date.now() < deadline) {
    await app!.renderOnce()
    text = app!.captureCharFrame().split("\n").map((l) => l.trimEnd()).join("\n").trimEnd()
    if (until(text)) break
    await Bun.sleep(20)
  }
  fs.mkdirSync(FRAMES, { recursive: true })
  fs.writeFileSync(path.join(FRAMES, `${name}.txt`), text + "\n")
  return text
}

describe("rewind dialogs", () => {
  test("checkpoint picker lists turns newest first with the disk-usage line", async () => {
    const calls: { path: string }[] = []
    const { DialogRewind } = await import("../../src/ezk/ux/dialogs")
    await mount(() => <DialogRewind sessionID="ses_test" />, calls)
    const text = await frame("rewind-checkpoints", (t) => t.includes("3.1 MB"))
    expect(text).toContain("Rewind to a checkpoint")
    expect(text.indexOf("change the login form")).toBeLessThan(text.indexOf("explain the project"))
    expect(text).toContain("2 files changed since")
    expect(text).toContain("Checkpoint storage on disk: 3.1 MB")
    expect(calls[0]!.path).toBe("/ezk/ux/checkpoints")
  })

  test("mode picker offers the four choices; enter on the first one rewinds files and chat", async () => {
    const calls: { path: string; body?: any }[] = []
    const { DialogRewindMode } = await import("../../src/ezk/ux/dialogs")
    let restored = ""
    await mount(() => <DialogRewindMode sessionID="ses_test" checkpoint={checkpoints.checkpoints[0]!} restorePrompt={(id) => (restored = id)} />, calls)
    const text = await frame("rewind-mode", (t) => t.includes("Summarize from here"))
    for (const label of ["Files and chat", "Files only", "Chat only", "Summarize from here"]) expect(text).toContain(label)
    app!.mockInput.pressEnter()
    // ux-safety: rewind now asks first, and Cancel is the default; move to the confirm button and accept
    await frame("rewind-confirm", (t) => t.includes("Cancel"))
    app!.mockInput.pressArrow("left")
    await Bun.sleep(50)
    app!.mockInput.pressEnter()
    const deadline = Date.now() + 2000
    while (!calls.some((c) => c.path === "/ezk/ux/rewind") && Date.now() < deadline) await Bun.sleep(20)
    expect(calls.find((c) => c.path === "/ezk/ux/rewind")!.body).toMatchObject({ sessionID: "ses_test", messageID: "msg_3", mode: "both" })
    while (!restored && Date.now() < deadline) await Bun.sleep(20)
    expect(restored).toBe("msg_3")
  })

  test("toast text names restored and skipped files", () => {
    expect(rewindMessage({ mode: "files", restored: ["/p/a.ts"], skipped: ["/p/src/b.ts"] })).toBe(
      "Restored 1 file(s). Left 1 file(s) alone because they were changed outside the agent: src/b.ts",
    )
    expect(rewindMessage({ mode: "summarize", restored: [], skipped: [] })).toBe("The later messages were replaced with a summary.")
    expect(rewindModeOptions({ snapshot: undefined, files: [] })[1]!.disabled).toBe(true)
  })

  test("Esc-Esc: the second press within the window opens rewind, a slow one only hints", () => {
    let t = 0
    const seen: string[] = []
    const press = doublePress({ windowMs: 1500, onFirst: () => seen.push("hint"), onDouble: () => seen.push("open"), now: () => t })
    press()
    t = 1000
    press()
    t = 5000
    press()
    t = 9000
    press()
    expect(seen).toEqual(["hint", "open", "hint", "hint"])
  })
})

describe("plan approval card", () => {
  const plan = "1. Add the parser in src/parse.ts\n2. Call it from src/main.ts\n3. Run bun test"

  test("shows the four choices and the plan; approve & run sends auto mode with the plan text", async () => {
    const calls: { path: string; body?: any }[] = []
    const { DialogPlanApproval } = await import("../../src/ezk/ux/dialogs")
    await mount(() => <DialogPlanApproval sessionID="ses_test" plan={plan} />, calls)
    const text = await frame("plan-approval", (t) => t.includes("Edit the plan"))
    for (const o of planApprovalOptions()) expect(text).toContain(o.title)
    expect(text).toContain("Add the parser in src/parse.ts")
    app!.mockInput.pressEnter()
    const deadline = Date.now() + 2000
    while (!calls.some((c) => c.path === "/ezk/ux/plan/approve") && Date.now() < deadline) await Bun.sleep(20)
    expect(calls.find((c) => c.path === "/ezk/ux/plan/approve")!.body).toMatchObject({ sessionID: "ses_test", mode: "auto", text: plan })
  })

  test("Indonesian labels match the owner's wording", () => {
    expect(ut("plan.auto", {}, "id")).toBe("Setujui & jalankan (Edit otomatis)")
    expect(ut("plan.ask", {}, "id")).toBe("Setujui & tanya tiap langkah")
    expect(ut("plan.keep", {}, "id")).toBe("Lanjut merencanakan")
    expect(ut("plan.edit", {}, "id")).toBe("Edit rencana")
  })

  test("every string exists in both languages and names no supplier", () => {
    expect(Object.keys(UX_STRINGS.id).toSorted()).toEqual(Object.keys(UX_STRINGS.en).toSorted())
    const all = [...Object.values(UX_STRINGS.en), ...Object.values(UX_STRINGS.id)].join(" ")
    expect(all).not.toMatch(/examplevendor|partner|\bmac\b/i)
  })
})
