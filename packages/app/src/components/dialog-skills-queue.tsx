import { createResource, For, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

type Proposal = { id: string; name: string; description: string; state: "pending" }

export function DialogSkillsQueue() {
  const language = useLanguage()
  const [proposals, { refetch }] = createResource<Proposal[]>(async () => (await window.api?.skills?.pending()) ?? [])
  const update = async (proposal: Proposal, action: "approve" | "reject") => {
    const api = window.api?.skills
    if (!api) return
    try {
      await api[action](proposal.id)
      await refetch()
    } catch {
      showToast({ variant: "error", title: language.t("dialog.skills.failed") })
    }
  }

  return (
    <Dialog title={language.t("dialog.skills.title")}>
      <List
        class="px-3"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.skills.empty")}
        key={(item) => item?.id ?? ""}
        items={() => proposals() ?? []}
        filterKeys={["name", "description"]}
      >
        {(proposal) => (
          <div class="w-full flex items-center justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate">{proposal.name}</span>
              <span class="truncate text-11-regular text-text-weaker">{proposal.description}</span>
            </div>
            <div class="flex shrink-0 gap-2" onClick={(event) => event.stopPropagation()}>
              <ButtonV2 size="small" onClick={() => void update(proposal, "approve")}>
                {language.t("dialog.skills.approve")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" onClick={() => void update(proposal, "reject")}>
                {language.t("dialog.skills.reject")}
              </ButtonV2>
            </div>
          </div>
        )}
      </List>
      <Show when={proposals.error}>
        <span role="alert">{language.t("dialog.skills.failed")}</span>
      </Show>
    </Dialog>
  )
}
