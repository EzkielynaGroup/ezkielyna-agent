import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

type DialogController = ReturnType<typeof useDialog>

export function confirmAction(
  dialog: DialogController,
  input: { title: string; message: string; confirm: string; destructive?: boolean },
) {
  return new Promise<boolean>((resolve) => {
    let confirmed = false
    void dialog.push(
      () => (
        <ConfirmActionDialog
          {...input}
          onConfirm={() => {
            confirmed = true
            dialog.close()
          }}
          onCancel={() => dialog.close()}
        />
      ),
      () => resolve(confirmed),
    )
  })
}

function ConfirmActionDialog(props: {
  title: string
  message: string
  confirm: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const language = useLanguage()
  return (
    <Dialog variant={props.destructive === false ? "default" : "destructive"}>
      <DialogHeader hideClose>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="px-5 py-3 text-[13px] text-v2-text-text-muted">
        <p>{props.message}</p>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="neutral" autofocus onClick={props.onCancel}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          type="button"
          variant={props.destructive === false ? "contrast" : "danger-solid"}
          onClick={props.onConfirm}
        >
          {props.confirm}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
