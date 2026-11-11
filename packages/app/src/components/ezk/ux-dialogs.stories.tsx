// @ts-nocheck
// Wave B "ux" lane: Desktop dialogs against a fake /ezk/ux server (no network). Used for the report screenshots.
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { onMount } from "solid-js"
import { DialogEzkHandoff, DialogEzkPlan, DialogEzkRewind } from "./ux-dialogs"

const conn = { url: "http://ezk.local" }
const checkpoints = {
  checkpoints: [
    { messageID: "msg_3", snapshot: "b".repeat(40), preview: "Change the login form and add a test", at: Date.UTC(2026, 9, 21, 2, 42), files: ["/p/src/login.ts", "/p/test/login.test.ts"], turns: 1 },
    { messageID: "msg_2", snapshot: "a".repeat(40), preview: "Make the error message friendlier", at: Date.UTC(2026, 9, 21, 2, 36), files: ["/p/src/login.ts"], turns: 2 },
    { messageID: "msg_1", snapshot: "c".repeat(40), preview: "Explain how sign-in works in this project", at: Date.UTC(2026, 9, 21, 2, 30), files: [], turns: 3 },
  ],
  diskBytes: 3_250_000,
  diskText: "3.1 MB",
}
const fake = (async (url) => {
  const path = new URL(String(url)).pathname
  if (path === "/ezk/ux/checkpoints") return Response.json(checkpoints)
  if (path === "/ezk/ux/plan/approve") return Response.json({ mode: "auto", todos: 3, forced: false })
  if (path === "/ezk/ux/handoff") return Response.json({ sessionID: "ses_new", prompt: "Continue", files: [] })
  return Response.json({ mode: "both", restored: [], skipped: [] })
}) as typeof fetch

const plan = [
  "Goal: show a friendly message when sign-in fails.",
  "",
  "1. Add `friendlyError()` in src/auth/errors.ts that maps server codes to plain sentences",
  "2. Use it in src/login.ts where the error banner is shown",
  "3. Add test/login.test.ts cases for a wrong password and a locked account",
  "4. Run bun test and check the banner by hand",
].join("\n")

function Open(props: { view: () => any }) {
  const dialog = useDialog()
  const open = () => dialog.show(props.view)
  onMount(open)
  return (
    <Button variant="secondary" onClick={open}>
      Open
    </Button>
  )
}

export default { title: "App/Ezkielyna/UX lane", id: "app-ezk-ux" }

export const RewindPick = { render: () => <Open view={() => <DialogEzkRewind conn={conn} sessionID="ses_demo" lang="en" fetch={fake} />} /> }
export const RewindModes = {
  render: () => <Open view={() => <DialogEzkRewind conn={conn} sessionID="ses_demo" lang="en" messageID="msg_3" fetch={fake} />} />,
}
export const RewindModesID = {
  render: () => <Open view={() => <DialogEzkRewind conn={conn} sessionID="ses_demo" lang="id" messageID="msg_3" fetch={fake} />} />,
}
export const PlanApproval = { render: () => <Open view={() => <DialogEzkPlan conn={conn} sessionID="ses_demo" lang="en" plan={plan} fetch={fake} />} /> }
export const PlanApprovalID = { render: () => <Open view={() => <DialogEzkPlan conn={conn} sessionID="ses_demo" lang="id" plan={plan} fetch={fake} />} /> }
export const Handoff = {
  render: () => <Open view={() => <DialogEzkHandoff conn={conn} sessionID="ses_demo" lang="id" fetch={fake} onCreated={() => {}} />} />,
}
