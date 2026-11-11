import { For, Show, onMount } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  let onceButton: HTMLButtonElement | undefined

  onMount(() => onceButton?.focus())

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          props.onDecide("reject")
          return
        }
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault()
          props.onDecide("once")
        }
      }}
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button
              ref={onceButton}
              variant="primary"
              size="normal"
              onClick={() => props.onDecide("once")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowOnce")}
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding || props.request.always.length === 0}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <div data-slot="permission-hint">
          {props.request.always.length > 0
            ? language.t("session.polish.permissionAlwaysScope", {
                permission: props.request.permission,
                patterns: props.request.always.join(", "),
              })
            : language.t("session.polish.permissionAlwaysUnavailable")}
        </div>
      </div>
    </DockPrompt>
  )
}
