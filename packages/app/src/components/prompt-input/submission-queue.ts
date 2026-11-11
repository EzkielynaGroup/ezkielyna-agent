export type PromptMode = "normal" | "shell"

export function followupQueueDecision(input: {
  hasSession: boolean
  mode: PromptMode
  followupQueue: boolean
  blockedByPermission: boolean
}) {
  if (!input.hasSession) return { queue: false, mode: input.mode }
  if (input.blockedByPermission) return { queue: true, mode: "normal" as const }
  if (input.mode === "normal" && input.followupQueue) return { queue: true, mode: input.mode }
  return { queue: false, mode: input.mode }
}
