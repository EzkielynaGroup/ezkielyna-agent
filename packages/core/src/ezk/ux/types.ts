// Ezkielyna Agent v3 "ux" lane: the minimal, structural view of a session transcript the pure ux logic needs.
// Session messages (SessionV1.WithParts) satisfy it; tests build plain objects.
export interface UxPart {
  type: string
  id?: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  [key: string]: any
}

export interface UxMessage {
  info: {
    id: string
    role: "user" | "assistant"
    time: { created: number; completed?: number }
    parentID?: string
    agent?: string
    finish?: string
    error?: unknown
    /** true on compaction summaries (assistant); a diff summary object on user messages */
    summary?: unknown
    [key: string]: any
  }
  parts: UxPart[]
}
