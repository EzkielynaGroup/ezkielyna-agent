import type { AssistantMessage, Part, ToolPart } from "@opencode-ai/sdk/v2"

export type TurnTestResult = {
  status: "not-run" | "running" | "passed" | "failed"
  count?: number
  durationMs?: number
}

export function isTestCommand(part: ToolPart) {
  const command = part.state.input.command
  if (typeof command !== "string") return false
  return /(?:^|[;&|\s])(?:bun\s+(?:x\s+)?(?:run\s+)?(?:test|vitest|jest|playwright)|npm\s+(?:run\s+)?(?:test|vitest|jest|playwright)|pnpm\s+(?:run\s+)?(?:test|vitest|jest|playwright)|yarn\s+(?:run\s+)?(?:test|vitest|jest|playwright)|deno\s+test|vitest(?:\s+run)?|jest(?:\s|$)|playwright\s+test|pytest(?:\s|$)|go\s+test(?:\s|$)|cargo\s+test(?:\s|$))/i.test(
    command,
  )
}

function testCount(text: string, state: "passed" | "failed") {
  const patterns =
    state === "failed"
      ? [/(\d+)\s+(?:tests?\s+)?fail(?:ed)?\b/i, /(?:tests?\s+)?(\d+)\s+fail(?:ed)?\b/i]
      : [/(\d+)\s+(?:tests?\s+)?pass(?:ed)?\b/i, /(?:tests?\s+)?(\d+)\s+pass(?:ed)?\b/i]
  for (const pattern of patterns) {
    const count = text.match(pattern)?.[1]
    if (count) return Number(count)
  }
}

export function turnTestResult(parts: Part[]): TurnTestResult {
  const testTools = parts.filter((part): part is ToolPart => part.type === "tool" && isTestCommand(part))
  if (testTools.length === 0) return { status: "not-run" }
  const latest = testTools.at(-1)!
  if (latest.state.status === "pending" || latest.state.status === "running") return { status: "running" }
  const start = latest.state.time.start
  const end = latest.state.time.end
  const durationMs = typeof start === "number" && typeof end === "number" ? Math.max(0, end - start) : undefined
  if (latest.state.status === "error") {
    return { status: "failed", count: testCount(latest.state.error, "failed"), durationMs }
  }
  const failed = testCount(latest.state.output, "failed")
  if ((failed ?? 0) > 0) return { status: "failed", count: failed, durationMs }
  const exit = latest.state.metadata.exit ?? latest.state.metadata.exitCode
  if (typeof exit === "number" && exit !== 0) return { status: "failed", durationMs }
  return { status: "passed", count: testCount(latest.state.output, "passed"), durationMs }
}

export function turnSummary(parts: Part[], limit = 220) {
  const value = parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .at(-1)
    ?.replace(/\s+/g, " ")
  if (!value) return undefined
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`
}

export function turnCachePercent(messages: AssistantMessage[]) {
  const totals = messages.reduce(
    (sum, message) => ({
      read: sum.read + message.tokens.cache.read,
      prompt: sum.prompt + message.tokens.input + message.tokens.cache.read + message.tokens.cache.write,
    }),
    { read: 0, prompt: 0 },
  )
  if (!totals.prompt) return undefined
  return Math.round((totals.read / totals.prompt) * 100)
}
