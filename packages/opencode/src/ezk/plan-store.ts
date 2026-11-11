// Ezkielyna Agent v3 U3: the process-wide store of approved plans (plan.md per session under <data>/ezk/sessions).
// Kept apart from ./plan so the ux plugin can read it without importing the session services (import cycle).
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { PlanStore } from "@opencode-ai/core/ezk/ux/store"

let store: PlanStore | undefined
export const planStore = () => (store ??= new PlanStore(path.join(Global.Path.data, "ezk", "sessions")))
