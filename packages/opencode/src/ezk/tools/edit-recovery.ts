const RULE = "re-read the file, then retry with the exact text"

function words(value: string) {
  return new Set((value.slice(0, 4_000).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((word) => word.length > 1).slice(0, 500))
}

function similarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0
  let common = 0
  for (const word of left) if (right.has(word)) common++
  return common / (left.size + right.size - common)
}

export function closestWindows(content: string, search: string, count = 3) {
  const lines = content.split(/\r?\n/)
  const needle = search.split(/\r?\n/).filter(Boolean).slice(0, 8).map((line) => line.slice(0, 300))
  const width = Math.max(1, needle.length)
  const needleWords = words(needle.join(" "))
  const candidates: Array<{ line: number; score: number; text: string }> = []
  const bound = Math.min(lines.length, 10_000)
  for (let start = 0; start < bound; start++) {
    const end = Math.min(bound, start + width)
    const window = lines.slice(start, end).map((line) => line.slice(0, 300))
    const text = window.join("\n")
    candidates.push({ line: start + 1, score: similarity(needleWords, words(text)), text })
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, count)
    .map((item) => ({ ...item, score: Number(item.score.toFixed(3)) }))
}

export function editMatchFailure(content: string, search: string, originalMessage: string) {
  const windows = closestWindows(content, search)
  if (!windows.length) return `${originalMessage}\n\nRule: ${RULE}.`
  const details = windows.map((item) => `- lines ${item.line}-${item.line + item.text.split("\n").length - 1}:\n  ${item.text.replaceAll("\n", "\n  ")}`)
  return `${originalMessage}\n\nClosest windows:\n${details.join("\n")}\n\nRule: ${RULE}.`
}

export function isEditMatchFailure(error: unknown) {
  return error instanceof Error && /Could not find oldString|Failed to find (?:context|sequence|expected lines)|did not match/i.test(error.message)
}
