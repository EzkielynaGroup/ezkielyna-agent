import { TextAttributes } from "@opentui/core"
import path from "node:path"
import { createMemo, createResource, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { Global } from "@opencode-ai/core/global"

type Action = { type: "approve" | "reject"; id: string }

export function DialogSkillsQueue() {
  const { theme } = useTheme()
  const [loadError, setLoadError] = createSignal<unknown>()
  const [queue, { refetch }] = createResource(async () => {
    const { SkillStore } = await import("@opencode-ai/core/ezk/skills")
    return new SkillStore(path.join(Global.Path.config, "skills")).pending().catch((error) => {
      setLoadError(error)
      return []
    })
  })

  const options = createMemo<DialogSelectOption<Action>[]>(() => {
    const entries = queue() ?? []
    if (entries.length === 0) return [{ title: "No pending skill proposals", value: { type: "reject", id: "" } }]
    return entries.flatMap(({ id, record }) => [
      {
        title: `Approve: ${record.name}`,
        description: record.description,
        category: "Pending",
        value: { type: "approve" as const, id },
      },
      {
        title: `Reject: ${record.name}`,
        description: record.description,
        category: "Pending",
        value: { type: "reject" as const, id },
      },
    ])
  })

  return (
    <DialogSelect
      title="Pending skill proposals"
      placeholder="Filter proposals…"
      options={options()}
      onSelect={async (option) => {
        if (!option.value.id) return
        const { SkillStore } = await import("@opencode-ai/core/ezk/skills")
        const store = new SkillStore(path.join(Global.Path.config, "skills"))
        if (option.value.type === "approve") await store.approve(option.value.id)
        else await store.reject(option.value.id)
        setLoadError(undefined)
        await refetch()
      }}
      emptyView={
        loadError() ? (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>Could not load skill proposals</text>
          </box>
        ) : undefined
      }
    />
  )
}
