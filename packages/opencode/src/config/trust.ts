import path from "path"
import { Global } from "@opencode-ai/core/global"
import { isProjectTrusted } from "@opencode-ai/core/ezkielyna-trust"

/** The user's list of trusted project folders (see core/src/ezkielyna-trust.ts). */
export const trustFile = () => path.join(Global.Path.config, "trusted-projects.json")

export const projectTrusted = (directory: string, worktree?: string) =>
  isProjectTrusted(worktree && worktree !== "/" ? worktree : directory, { file: trustFile() })
