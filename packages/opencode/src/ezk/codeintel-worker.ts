import { fileURLToPath } from "node:url"
import { CodeIndex, type SyncResult } from "@opencode-ai/core/ezk/codeintel/index"

export type CodeIndexWorkerInput = {
  file: string
  root: string
  git: boolean
  batchSize?: number
}

export type CodeIndexWorkerMessage =
  | { type: "ready" }
  | { type: "progress"; parsed: number; total: number }
  | { type: "result"; result: SyncResult }

export async function runCodeIndexWorker(input: CodeIndexWorkerInput, send = writeMessage) {
  const index = await CodeIndex.open(input.file, input.root)
  send({ type: "ready" })
  try {
    const result = await index.sync({
      git: input.git,
      batchSize: input.batchSize ?? 24,
      onProgress: (parsed, total) => send({ type: "progress", parsed, total }),
    })
    send({ type: "result", result })
    return result
  } finally {
    index.close()
  }
}

export function parseCodeIndexWorkerInput(value: string | undefined): CodeIndexWorkerInput {
  if (!value) throw new Error("Missing code index worker input")
  const input = JSON.parse(value) as Partial<CodeIndexWorkerInput>
  if (typeof input.file !== "string" || typeof input.root !== "string" || typeof input.git !== "boolean") {
    throw new Error("Invalid code index worker input")
  }
  const batchSize = typeof input.batchSize === "number" ? Math.max(1, Math.min(24, Math.floor(input.batchSize))) : 24
  return { file: input.file, root: input.root, git: input.git, batchSize }
}

function writeMessage(message: CodeIndexWorkerMessage) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

// This module is also dynamically imported by the compiled Bun CLI's small dispatcher.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runCodeIndexWorker(parseCodeIndexWorkerInput(process.argv[2])).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
