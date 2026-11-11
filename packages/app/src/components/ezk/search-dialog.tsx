import { For, Show, createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { type EzkConnection, ezkClient } from "./client"
import { ezkT } from "./strings"

// Full-text search of past sessions (FTS5 on the server). Clicking a hit opens that session.
export function DialogEzkSearch(props: { conn: EzkConnection; lang?: string; exclude?: string; onOpen: (sessionID: string, hit?: { directory?: string; title?: string }) => void }) {
  const t = ezkT(props.lang)
  const api = ezkClient(props.conn)
  const [q, setQ] = createSignal("")
  const [hits, setHits] = createSignal<Awaited<ReturnType<typeof api.search>>["hits"]>()
  const [note, setNote] = createSignal<string>()
  let timer: number | undefined

  const run = async (text: string) => {
    if (!text.trim()) return setHits(undefined)
    try {
      const r = await api.search(text.trim(), props.exclude)
      setHits(r.hits)
      setNote(r.builtMs !== undefined ? `${t("search.building")} ${r.builtMs} ms` : undefined)
    } catch (e) {
      setNote((e as Error).message)
    }
  }
  const onInput = (v: string) => {
    setQ(v)
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void run(v), 200)
  }

  return (
    <Dialog title={t("search.title")}>
      <div class="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pl-6 pr-4 pb-4" data-component="ezk-search">
        <input
          autofocus
          class="h-9 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-base px-3 text-[14px] text-v2-text-text-base outline-none focus:border-v2-border-border-strong"
          placeholder={t("search.placeholder")}
          value={q()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
        <Show when={note()}>
          <span class="text-[12px] text-v2-text-text-faint">{note()}</span>
        </Show>
        <Show when={hits()}>
          <For each={hits()} fallback={<span class="text-[13px] text-v2-text-text-muted">{t("search.none")}</span>}>
            {(hit) => (
              <button
                type="button"
                class="flex flex-col gap-0.5 rounded-[8px] px-2 py-1.5 text-left hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
                onClick={() => props.onOpen(hit.sessionID, hit)}
              >
                <span class="text-[11.5px] text-v2-text-text-muted">
                  {hit.title ?? hit.sessionID} · {new Date(hit.time).toLocaleDateString()} · {hit.role}
                </span>
                <span class="text-[13px] text-v2-text-text-base" innerHTML={escapeSnippet(hit.snippet)} />
              </button>
            )}
          </For>
        </Show>
      </div>
    </Dialog>
  )
}

/** Snippets mark matches with [ ]; escape everything, then turn the markers into <mark>. */
export function escapeSnippet(s: string) {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return esc.replace(/\[([^\]]*)\]/g, "<mark>$1</mark>")
}
