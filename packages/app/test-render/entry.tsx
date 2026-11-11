// Headless render fixtures for the U5 desktop pieces (chips, cost line, tasks list). Built by run.ts, never shipped.
import "../src/index.css"
import { For, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { EzkChips, EzkTasksList, EzkUsageBlock } from "../src/components/ezk/status-panel"
import { buildChips, taskRows, usageView } from "../src/components/ezk/status-model"

const permission = {
  flags: { modes: true },
  mode: { effective: "acceptEdits" },
  modes: [{ id: "acceptEdits", label: { en: "Auto-edit", id: "Edit otomatis" } }],
}
const chips = buildChips({ permission, trust: { trusted: true }, status: { sandbox: { active: true, kind: "seatbelt" }, webSearch: true } })
const chipsRisky = buildChips({ permission, trust: { trusted: false }, status: { sandbox: { active: false, kind: "none" }, webSearch: false } })
const view = usageView(
  {
    enabled: true,
    statusline: false,
    contextPct: 9.8,
    report: { steps: 4, tokens: { input: 3200, output: 1400, cacheRead: 38_000, cacheWrite: 0 }, costUSD: 0.0042, cacheHitPct: 92.2, lastHitPct: 95, lastPromptTokens: 12_400, lastModelID: "deepseek-v4.1-flash" },
  },
  { sandbox: { active: true, kind: "seatbelt" }, webSearch: true, exec: true, agentContext: 128_000, price: { model: "deepseek-v4.1-flash", groupRatio: 1.5, perMtok: { input: 0.0056, output: 0.03, cachedInput: 0.0014 } } },
)
const now = Date.now()
const tasks = taskRows(
  [
    { id: "bg_1", owner: "s", command: "bun run dev --port 5173", cwd: "/p", pid: 1, backend: "pty", monitor: true, status: "running", startedAt: now - 125_000, lastAttendedAt: now, bytes: 90, preview: "VITE v6 ready in 312 ms\n➜ Local: http://localhost:5173/\n➜ press h to show help" },
    { id: "bg_2", owner: "s", command: "bun test --watch", cwd: "/p", pid: 2, backend: "pipe", monitor: false, status: "exited", exitCode: 0, startedAt: now - 400_000, endedAt: now - 300_000, lastAttendedAt: now, bytes: 20, preview: "12 pass\n0 fail" },
    { id: "bg_3", owner: "s", command: "tail -f server.log", cwd: "/p", pid: 3, backend: "pipe", monitor: false, status: "killed", startedAt: now - 900_000, endedAt: now - 800_000, lastAttendedAt: now, bytes: 0, preview: "" },
  ] as never,
  now,
)

function Section(props: { lang: "en" | "id" }) {
  const [open, setOpen] = createSignal<string>()
  return (
    <section data-lang={props.lang} class="flex w-[264px] flex-col gap-3 rounded-[14px] bg-v2-background-bg-layer-01 p-2" style={{ "background-color": "#fff" }}>
      <EzkChips chips={chips} lang={props.lang} />
      <EzkChips chips={chipsRisky} lang={props.lang} />
      <EzkUsageBlock view={view} lang={props.lang} />
      <EzkUsageBlock view={undefined} lang={props.lang} />
      <div data-slot="tasks" class="flex flex-col gap-1 px-2">
        <EzkTasksList rows={tasks} lang={props.lang} openId={open()} output={"line 1\nline 2\nline 3"} onToggle={(r) => setOpen(open() === r.id ? undefined : r.id)} onStop={() => {}} />
      </div>
    </section>
  )
}

render(
  () => (
    <div style={{ display: "flex", gap: "16px", "align-items": "flex-start" }}>
      <For each={["en", "id"] as const}>{(lang) => <Section lang={lang} />}</For>
    </div>
  ),
  document.getElementById("root")!,
)
;(window as unknown as { ready: boolean }).ready = true
