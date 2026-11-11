import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { createSignal, Show } from "solid-js"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import type { KeyGroupModel } from "@opencode-ai/core/ezk/key-group"
import { KeyGroupHint } from "./key-group-hint"
import { SecretInputV2 } from "@/components/secret-input-v2"
import { maskedApiKey, validateAndSaveEzkielynaKey } from "./key-validation"
import { ezkToast } from "@/utils/toast"
import { usePlatform } from "@/context/platform"
import { Mark } from "@opencode-ai/ui/logo"
import { createSecretKeyState } from "./secret-key-state"

export function DialogChangeEzkielynaKey(props: { refresh: () => Promise<unknown>; firstRun?: boolean }) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const keyState = createSecretKeyState()
  const key = keyState.value
  const setKey = keyState.setValue
  const [error, setError] = createSignal<string>()
  const [saved, setSaved] = createSignal<string>()
  const [models, setModels] = createSignal<KeyGroupModel[]>([])
  const [pending, setPending] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending()) return
    const value = key().trim()
    if (!value) {
      setError(language.t("provider.connect.apiKey.required"))
      return
    }

    setPending(true)
    setError(undefined)
    try {
      const result = await validateAndSaveEzkielynaKey({
        key: value,
        save: (secret) =>
          serverSDK().client.auth.set({
            providerID: EZK.providerID,
            auth: { type: "api", key: secret },
          }),
        refresh: async () => {
          await serverSDK().client.global.dispose()
          await props.refresh()
        },
      })
      if (!result) {
        setError(language.t("ezk.keyChange.invalid"))
        return
      }
      setModels(result)
      setSaved(maskedApiKey(value))
      keyState.clear()
      ezkToast({
        kind: "success",
        title: language.t("ezk.keyChange.success.title"),
        detail: language.t("ezk.keyChange.success.description"),
      })
    } catch {
      setError(language.t("ezk.keyChange.failed"))
      ezkToast({ kind: "error", title: language.t("ezk.keyChange.failed") })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog class={props.firstRun ? "ezk-connect-dialog" : undefined} size={props.firstRun ? "large" : "normal"} fit={props.firstRun}>
      <DialogHeader>
        <Show when={props.firstRun}>
          <div class="ezk-connect-brand">
            <Mark class="size-12 rounded-[12px]" />
            <span>{language.t("ezk.firstRun.step")}</span>
          </div>
        </Show>
        <DialogTitle>
          {language.t(props.firstRun && saved() ? "ezk.firstRun.savedTitle" : props.firstRun ? "ezk.firstRun.title" : "ezk.keyChange.title")}
        </DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-4 px-5 py-3">
        <p class="text-[13px] text-v2-text-text-muted">
          {language.t(
            props.firstRun && saved()
              ? "ezk.firstRun.savedDescription"
              : props.firstRun
                ? "ezk.firstRun.description"
                : "ezk.keyChange.description",
          )}
        </p>
        <Show when={props.firstRun && !saved()}>
          <div class="flex flex-wrap gap-2">
            <ButtonV2 type="button" variant="neutral" size="small" onClick={() => void platform.openExternal(EZK.keysURL)}>
              {language.t("ezk.firstRun.getKey")}
            </ButtonV2>
            <ButtonV2 type="button" variant="neutral" size="small" onClick={() => void platform.openExternal(EZK.storeURL)}>
              {language.t("ezk.firstRun.buyPackage")}
            </ButtonV2>
          </div>
        </Show>
        <form class="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
          <Show when={!props.firstRun || !saved()}>
            <label class="flex flex-col gap-1 text-[12px] font-medium text-v2-text-text-base">
              {language.t("provider.connect.apiKey.label", { provider: EZK.providerName })}
              <SecretInputV2
                class="!w-full"
                name="apiKey"
                data-input="ezk-change-api-key"
                placeholder={language.t("provider.connect.apiKey.placeholder")}
                autofocus={props.firstRun && !saved()}
                value={key()}
                disabled={pending()}
                aria-describedby={error() ? "ezk-key-change-error" : undefined}
                invalid={error() !== undefined}
                onInput={(event) => {
                  setKey(event.currentTarget.value)
                  setError(undefined)
                }}
              />
            </label>
            <Show when={error()}>
              {(message) => <p id="ezk-key-change-error" role="alert" class="text-[12px] text-v2-state-fg-danger">{message()}</p>}
            </Show>
          </Show>
          <Show when={saved()}>
            {(value) => (
              <div class="flex flex-col gap-1 rounded-[8px] bg-v2-background-bg-layer-02 px-3 py-2" data-component="saved-key-summary">
                <span class="text-[12px] text-v2-text-text-base">{language.t("ezk.keyChange.saved", { key: value() })}</span>
                <KeyGroupHint models={models()} />
              </div>
            )}
          </Show>
          <DialogFooter>
            <ButtonV2 type="button" variant="neutral" autofocus={!props.firstRun || !!saved()} onClick={() => dialog.close()}>
              {language.t(props.firstRun && saved() ? "ezk.firstRun.continue" : props.firstRun ? "ezk.firstRun.skip" : "common.cancel")}
            </ButtonV2>
            <Show when={!props.firstRun || !saved()}>
              <ButtonV2 type="submit" variant="contrast" disabled={pending()}>
                {pending() ? language.t("common.saving") : language.t("common.save")}
              </ButtonV2>
            </Show>
          </DialogFooter>
        </form>
      </DialogBody>
    </Dialog>
  )
}
