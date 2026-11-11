import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useHomeSessionDestination } from "../../routes/home/session-destination"
import { AccountQuota } from "../../component/account-quota"
import { isBetaBuild, shouldShowBetaWelcome } from "@opencode-ai/core/ezk/diag/beta-welcome"
import { betaT } from "../../ezk/beta-strings"

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const destination = useHomeSessionDestination()
  const paths = useTuiPaths()
  const dir = createMemo(() => {
    const selected = destination?.destination()
    if (!selected || selected.type === "new") return
    const out = abbreviateHome(selected.directory, paths.home)
    const branch =
      selected.directory === (props.api.state.path.directory || paths.cwd) ? props.api.state.vcs?.branch : undefined
    if (branch) return out + ":" + branch
    return out
  })

  return <Show when={dir()}>{(value) => <text fg={theme().textMuted}>{value()}</text>}</Show>
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>{props.api.app.version}</text>
    </box>
  )
}

function BetaWelcome(props: { api: TuiPluginApi }) {
  const version = props.api.app.version
  const [visible, setVisible] = createSignal(false)
  const t = betaT()
  const rows = [t("try.fix"), t("try.tests"), t("try.auto")]

  createEffect(() => {
    const seen = props.api.kv.get("ezk.beta.welcome.seenVersion")
    const dismissed = typeof seen === "string" ? seen : undefined
    if (!props.api.kv.ready || !isBetaBuild(version) || !shouldShowBetaWelcome(version, dismissed)) return
    setVisible(true)
    props.api.kv.set("ezk.beta.welcome.seenVersion", version)
  })

  return (
    <Show when={visible()}>
      <box
        width="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="column"
        flexShrink={0}
        backgroundColor={props.api.theme.current.backgroundElement}
      >
        <text fg={props.api.theme.current.text}>
          {t("title").replace("{version}", version)}
        </text>
        <For each={rows}>{(row) => <text fg={props.api.theme.current.textMuted}>• {row}</text>}</For>
        <text fg={props.api.theme.current.textMuted}>{t("hint")}</text>
      </box>
    </Show>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (
    <box width="100%" flexDirection="column" flexShrink={0}>
      <BetaWelcome api={props.api} />
      <box
        width="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        flexShrink={0}
        gap={2}
      >
        <Directory api={props.api} />
        <Mcp api={props.api} />
        <box flexGrow={1} />
        <AccountQuota color={props.api.theme.current.textMuted} />
        <Version api={props.api} />
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
