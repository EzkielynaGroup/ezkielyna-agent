import type { Part, SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { SummaryDiff } from "./timeline-row"

export function uniqueSummaryDiffs(diffs: SnapshotFileDiff[] | undefined) {
  const files = new Set<string>()
  return (diffs ?? [])
    .reduceRight<SummaryDiff[]>((result, diff) => {
      if (!isSummaryDiff(diff)) return result
      const file = diff.file
      if (files.has(file)) return result
      files.add(file)
      result.push(diff)
      return result
    }, [])
    .reverse()
}

export function turnSummaryDiffs(diffs: SnapshotFileDiff[] | undefined, parts: Part[]) {
  const fromTools = parts.flatMap((part): SnapshotFileDiff[] => {
    if (part.type !== "tool" || part.state.status !== "completed") return []
    const metadata = part.state.metadata
    const filediff = metadata.filediff
    if (record(filediff) && typeof filediff.file === "string")
      return [
        {
          file: filediff.file,
          patch: typeof filediff.patch === "string" ? filediff.patch : undefined,
          additions: typeof filediff.additions === "number" ? filediff.additions : 0,
          deletions: typeof filediff.deletions === "number" ? filediff.deletions : 0,
          ...(filediff.status === "added" || filediff.status === "deleted" || filediff.status === "modified"
            ? { status: filediff.status }
            : {}),
        },
      ]

    const files = metadata.files
    if (Array.isArray(files)) {
      const listed = files.flatMap((value): SnapshotFileDiff[] => {
        if (!record(value)) return []
        const file = [value.relativePath, value.file, value.filePath].find(
          (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
        )
        if (!file) return []
        return [
          {
            file,
            patch: typeof value.patch === "string" ? value.patch : undefined,
            additions: typeof value.additions === "number" ? value.additions : 0,
            deletions: typeof value.deletions === "number" ? value.deletions : 0,
            ...(value.type === "add" ? { status: "added" as const } : {}),
            ...(value.type === "delete" ? { status: "deleted" as const } : {}),
          },
        ]
      })
      if (listed.length) return listed
    }

    if (!["write", "edit", "apply_patch", "patch"].includes(part.tool)) return []
    const inputPath = part.state.input.filePath
    const file = [part.state.title, metadata.filepath, inputPath, part.state.input.path].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    )
    if (!file) return []
    return [
      {
        file,
        additions: 0,
        deletions: 0,
        ...(metadata.exists === false ? { status: "added" as const } : {}),
      },
    ]
  })
  return uniqueSummaryDiffs([...fromTools, ...(diffs ?? [])])
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isSummaryDiff(diff: SnapshotFileDiff): diff is SummaryDiff {
  return typeof diff.file === "string"
}
