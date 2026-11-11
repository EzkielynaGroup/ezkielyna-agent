// Ezkielyna Agent v3 U3: the approved plan of a session, kept as `plan.md` next to a small state file under
// <data>/ezk/sessions/<sessionID>/. Nothing is written into the user's project folder.
import fs from "node:fs"
import path from "node:path"
import type { ApprovalMode, ApprovedPlan } from "./plan"

const SAFE_ID = /^[\w-]{1,128}$/

export class PlanStore {
  constructor(readonly root: string) {}

  dir(sessionID: string) {
    if (!SAFE_ID.test(sessionID)) throw new Error("bad session id")
    return path.join(this.root, sessionID)
  }

  planPath(sessionID: string) {
    return path.join(this.dir(sessionID), "plan.md")
  }

  save(sessionID: string, input: { plan: string; messageID: string; mode: ApprovalMode; at?: number }): ApprovedPlan {
    const dir = this.dir(sessionID)
    fs.mkdirSync(dir, { recursive: true })
    const state: ApprovedPlan = { messageID: input.messageID, plan: input.plan, mode: input.mode, at: input.at ?? Date.now() }
    fs.writeFileSync(path.join(dir, "plan.md"), input.plan.trimEnd() + "\n")
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ messageID: state.messageID, mode: state.mode, at: state.at }))
    this.cache.set(sessionID, state)
    return state
  }

  private cache = new Map<string, ApprovedPlan | null>()

  get(sessionID: string): ApprovedPlan | undefined {
    if (!SAFE_ID.test(sessionID)) return
    const hit = this.cache.get(sessionID)
    if (hit !== undefined) return hit ?? undefined
    try {
      const dir = this.dir(sessionID)
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")) as Partial<ApprovedPlan>
      const plan = fs.readFileSync(path.join(dir, "plan.md"), "utf8")
      if (typeof meta.messageID !== "string" || (meta.mode !== "auto" && meta.mode !== "ask")) throw new Error("bad plan state")
      const state: ApprovedPlan = { messageID: meta.messageID, plan, mode: meta.mode, at: typeof meta.at === "number" ? meta.at : 0 }
      this.cache.set(sessionID, state)
      return state
    } catch {
      this.cache.set(sessionID, null)
      return
    }
  }

  clear(sessionID: string) {
    if (!SAFE_ID.test(sessionID)) return
    fs.rmSync(this.dir(sessionID), { recursive: true, force: true })
    this.cache.set(sessionID, null)
  }
}
