import { For, Show, createResource, createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { confirmAction } from "@/components/confirm-action"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { type EzkConnection, ezkClient } from "./client"
import { ezkT } from "./strings"

// Memory panel: what is saved (editable), first-use notice, Private session toggle, "Erase memory". The server owns the logic.
export function DialogEzkMemory(props: { conn: EzkConnection; sessionID?: string; lang?: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const t = ezkT(props.lang)
  const api = ezkClient(props.conn)
  const [status, { refetch }] = createResource(() => api.memory(props.sessionID))
  const [draft, setDraft] = createSignal("")
  const [message, setMessage] = createSignal<string>()

  const togglePrivate = async (element: HTMLInputElement) => {
    if (!props.sessionID) return
    const nextPrivate = !status()?.private
    const confirmed = await confirmAction(dialog, {
      title: language.t("ezk.action.memory.private.title"),
      message: language.t(nextPrivate ? "ezk.action.memory.private.onConfirm" : "ezk.action.memory.private.offConfirm"),
      confirm: language.t("ezk.action.memory.private.confirm"),
      destructive: false,
    })
    if (!confirmed) {
      element.checked = !!status()?.private
      return
    }
    try {
      await api.setPrivate(props.sessionID, nextPrivate)
      await refetch()
      showToast({
        variant: "success",
        title: language.t(nextPrivate ? "ezk.action.memory.private.on" : "ezk.action.memory.private.off"),
      })
    } catch {
      element.checked = !!status()?.private
      showToast({ variant: "error", title: language.t("common.requestFailed") })
    }
  }
  const add = async () => {
    const text = draft().trim()
    if (!text) return
    try {
      const r = await api.op({ action: "add", store: "user", text })
      setMessage(r.ok ? undefined : language.t("ezk.action.memory.add.failed"))
      if (r.ok) {
        setDraft("")
        showToast({ variant: "success", title: language.t("ezk.action.memory.add.success") })
      } else {
        showToast({ variant: "error", title: language.t("ezk.action.memory.add.failed") })
      }
      await refetch()
    } catch {
      showToast({ variant: "error", title: language.t("ezk.action.memory.add.failed") })
    }
  }
  const remove = async (store: "memory" | "user", match: string) => {
    const confirmed = await confirmAction(dialog, {
      title: language.t("ezk.action.memory.remove.title"),
      message: language.t("ezk.action.memory.remove.message", { note: match }),
      confirm: language.t("ezk.action.memory.remove.confirm"),
    })
    if (!confirmed) return
    try {
      const result = await api.op({ action: "remove", store, match })
      if (!result.ok) throw new Error("remove failed")
      showToast({ variant: "success", title: language.t("ezk.action.memory.remove.success") })
      await refetch()
    } catch {
      showToast({ variant: "error", title: language.t("ezk.action.memory.remove.failed") })
    }
  }
  const erase = async () => {
    const confirmed = await confirmAction(dialog, {
      title: language.t("ezk.action.memory.erase.title"),
      message: language.t("ezk.action.memory.erase.message"),
      confirm: language.t("ezk.action.memory.erase.confirm"),
    })
    if (!confirmed) return
    try {
      await api.wipe()
      setMessage(t("memory.erased"))
      showToast({ variant: "success", title: language.t("ezk.action.memory.erase.success") })
      await refetch()
    } catch {
      showToast({ variant: "error", title: language.t("ezk.action.memory.erase.failed") })
    }
  }
  const section = (title: string, store: "memory" | "user") => (
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between text-[11px] font-[560] uppercase tracking-wide text-v2-text-text-faint">
        <span>{title}</span>
        <span>
          {status()?.[store].chars}/{status()?.[store].limit}
        </span>
      </div>
      <For
        each={status()?.[store].entries}
        fallback={<span class="px-1 text-[12.5px] text-v2-text-text-faint">{t("memory.empty")}</span>}
      >
        {(text) => (
          <div class="flex items-start gap-2 rounded-[8px] bg-v2-background-bg-layer-03 px-2 py-1.5 text-[13px] text-v2-text-text-base">
            <span class="min-w-0 flex-1 break-words">{text}</span>
            <button
              type="button"
              class="shrink-0 text-[12px] text-v2-text-text-muted hover:text-v2-text-text-base"
              onClick={() => remove(store, text)}
            >
              {t("memory.remove")}
            </button>
          </div>
        )}
      </For>
    </div>
  )

  return (
    <Dialog title={t("memory.title")} description={t("memory.sub")}>
      <div class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pl-6 pr-4 pb-4" data-component="ezk-memory">
        <label class="flex items-start gap-3 text-[13px] text-v2-text-text-base">
          <input
            type="checkbox"
            class="mt-0.5"
            checked={!!status()?.private}
            disabled={!props.sessionID}
            onChange={(event) => void togglePrivate(event.currentTarget)}
          />
          <span class="flex flex-col">
            <span class="font-[560]">{t("memory.private")}</span>
            <span class="text-[12px] text-v2-text-text-muted">
              {props.sessionID ? t("memory.private.hint") : t("memory.private.none")}
            </span>
          </span>
        </label>

        {section(t("memory.you"), "user")}
        {section(t("memory.env"), "memory")}

        <div class="flex items-center gap-2">
          <input
            class="h-8 min-w-0 flex-1 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-border-border-strong"
            placeholder={t("memory.add.placeholder")}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            maxLength={400}
          />
          <Button variant="secondary" size="small" onClick={add}>
            {t("memory.save")}
          </Button>
        </div>
        <Show when={message()}>
          <span class="text-[12.5px] text-v2-text-text-muted">{message()}</span>
        </Show>

        <div class="flex flex-col gap-1 text-[12px] text-v2-text-text-muted">
          <span>
            {t("memory.review")}:{" "}
            {status()?.lastReview
              ? `${new Date(status()!.lastReview!.at).toLocaleString()} · +${status()!.lastReview!.applied}${status()!.lastReview!.error ? ` · ${status()!.lastReview!.error}` : ""}`
              : t("memory.review.none")}
          </span>
        </div>

        <div class="flex items-center justify-between gap-3 border-t border-v2-border-border-muted pt-3">
          <span class="text-[12px] text-v2-text-text-muted">{t("memory.erase.hint")}</span>
          <Button variant="ghost" size="small" onClick={erase}>
            {t("memory.erase")}
          </Button>
        </div>
        <div class="flex justify-end">
          <Button variant="ghost" size="small" onClick={() => dialog.close()}>
            OK
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
