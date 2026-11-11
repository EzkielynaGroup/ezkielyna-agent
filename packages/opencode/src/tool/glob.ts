import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"
import * as Truncate from "./truncate"
import { formatOmittedBytes, headTailPreview } from "../ezk/tools/output"
import { Global } from "@opencode-ai/core/global"
import { loadFlags } from "@opencode-ai/core/ezk/flags"

const GLOB_BOUNDING = loadFlags([Global.Path.config]).tools.boundedOutput

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const truncate = yield* Truncate.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })

          const inlineLimit = 100
          const scanLimit = GLOB_BOUNDING ? 50_000 : 100
          const files = yield* ripgrep.glob({ cwd: search, pattern: params.pattern, limit: scanLimit + (GLOB_BOUNDING ? 1 : 0) })
          const scanCapped = GLOB_BOUNDING && files.length > scanLimit
          const complete = files.slice(0, scanLimit)
          const truncated = GLOB_BOUNDING ? complete.length > inlineLimit || scanCapped : files.length === inlineLimit

          const allOutput = complete.map((file) => path.resolve(search, file.path)).join("\n")
          const inlineOutput = complete.slice(0, inlineLimit).map((file) => path.resolve(search, file.path)).join("\n")
          let output = files.length === 0 ? "No files found" : inlineOutput
          let outputPath: string | undefined
          if (truncated && GLOB_BOUNDING) {
            outputPath = yield* truncate.write(allOutput)
            const preview = headTailPreview(allOutput, 2_000)
            output = `${formatOmittedBytes(preview.head, preview.tail, preview.omittedBytes)}\n\nFull output saved to: ${outputPath}`
            if (scanCapped) output += `\nSearch stopped at ${scanLimit} entries to keep memory bounded; narrow the pattern to inspect the rest.`
          }
          if (truncated && !GLOB_BOUNDING) {
            output += `\n\n(Results are truncated: showing first ${inlineLimit} results. Consider using a more specific path or pattern.)`
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated,
              ...(outputPath ? { outputPath } : {}),
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
