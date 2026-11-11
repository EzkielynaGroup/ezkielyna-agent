import type { JSXElement } from "solid-js"
import { Show } from "solid-js"
import { ButtonV2 } from "./button-v2"
import { Icon, type IconProps } from "./icon"
import "./empty-state-v2.css"

export interface EmptyStateV2Props {
  icon?: IconProps["name"]
  title: JSXElement
  description?: JSXElement
  action?: { label: string; onClick: () => void }
  class?: string
  size?: "compact" | "normal"
}

export function EmptyStateV2(props: EmptyStateV2Props) {
  return (
    <section
      class={props.class}
      data-component="empty-state-v2"
      data-size={props.size ?? "normal"}
      role="status"
    >
      <Show when={props.icon}>
        {(icon) => (
          <span data-slot="empty-state-icon" aria-hidden="true">
            <Icon name={icon()} />
          </span>
        )}
      </Show>
      <h3 data-slot="empty-state-title">{props.title}</h3>
      <Show when={props.description}>
        {(description) => <p data-slot="empty-state-description">{description()}</p>}
      </Show>
      <Show when={props.action}>
        {(action) => (
          <ButtonV2 type="button" size="small" variant="neutral" onClick={action().onClick}>
            {action().label}
          </ButtonV2>
        )}
      </Show>
    </section>
  )
}
