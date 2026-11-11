export type EditToolName = "edit" | "apply_patch"

/** Keep the existing family preference until paired replay data shows a clear first-try winner. */
export function preferredEditTool(modelID: string): EditToolName {
  const id = modelID.toLowerCase()
  return id.includes("gpt-") && !id.includes("oss") && !id.includes("gpt-4") ? "apply_patch" : "edit"
}

export function shouldExposeEditTool(modelID: string, tool: string, applyPatchEverywhere: boolean) {
  if (applyPatchEverywhere) return tool === "edit" || tool === "write" || tool === "apply_patch"
  const preferred = preferredEditTool(modelID)
  if (tool === "apply_patch") return preferred === "apply_patch"
  if (tool === "edit" || tool === "write") return preferred !== "apply_patch"
  return true
}
