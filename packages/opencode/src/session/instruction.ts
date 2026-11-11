import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@opencode-ai/core/global"
import { loadFlags } from "@opencode-ai/core/ezk/flags"
import { discoverInstructions, rulesForFile, type DiscoverOptions } from "@opencode-ai/core/ezk/context/instructions"
import { projectTrusted } from "@/config/trust"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    // C4 (security): a folder the user has not trusted is somebody else's text. Its AGENTS.md / CLAUDE.md are a prompt-injection
    // vector, so none of the project's instruction files reach the model until `ezkielyna trust` (the user's own global files do).
    const projectTrust = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return {
        trusted: projectTrusted(ctx.directory, ctx.worktree),
        root: ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory,
      }
    })
    const insideProject = (root: string, file: string) => {
      const rel = path.relative(root, path.resolve(file))
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
    }

    // C1 (flag ezk.context.hierarchy, default off): user -> root..cwd -> local hierarchy, see core/src/ezk/context/instructions.ts
    const hierarchyOptions = Effect.fnUntraced(function* () {
      if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return undefined
      if (!loadFlags([global.config]).context.hierarchy) return undefined
      const ctx = yield* InstanceState.context
      const root = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
      return {
        cwd: ctx.directory,
        root,
        userDir: global.config,
        home: global.home,
        trusted: projectTrusted(ctx.directory, ctx.worktree),
      } satisfies DiscoverOptions
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const configPaths = Effect.fnUntraced(function* (trusted: boolean, root: string) {
      const config = yield* cfg.get()
      const paths = new Set<string>()
      for (const raw of config.instructions ?? []) {
        if (raw.startsWith("https://") || raw.startsWith("http://")) continue
        const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
        const matches = yield* (
          path.isAbsolute(instruction)
            ? fs.glob(path.basename(instruction), {
                cwd: path.dirname(instruction),
                absolute: true,
                include: "file",
              })
            : relative(instruction)
        ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const item of matches) {
          const resolved = path.resolve(item)
          // an untrusted project may not pull its own files in through `instructions`
          if (!trusted && !path.relative(root, resolved).startsWith("..")) continue
          paths.add(resolved)
        }
      }
      return paths
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const hier = yield* hierarchyOptions()
      if (hier) {
        const paths = new Set(discoverInstructions(hier).files.map((f) => f.path))
        for (const item of yield* configPaths(hier.trusted, hier.root)) paths.add(item)
        return paths
      }
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      const { trusted, root } = yield* projectTrust()

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG && trusted) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => {
            // an untrusted project may not pull its own files in through `instructions`
            if (!trusted && insideProject(root, item)) return
            paths.add(path.resolve(item))
          })
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const hier = yield* hierarchyOptions()
      if (hier) {
        const found = discoverInstructions(hier)
        const known = new Set(found.files.map((f) => f.path))
        const extra = Array.from(yield* configPaths(hier.trusted, hier.root)).filter((item) => !known.has(item))
        const extraFiles = yield* Effect.forEach(extra, read, { concurrency: 8 })
        const urls = (config.instructions ?? []).filter((item) => item.startsWith("https://") || item.startsWith("http://"))
        const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })
        return [
          ...found.parts,
          ...extra.flatMap((item, i) => (extraFiles[i] ? [`Instructions from: ${item}\n${extraFiles[i]}`] : [])),
          ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
        ]
      }
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      if (!(yield* projectTrust()).trusted) return []
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      // C1: path-scoped rules/*.md apply when a matching file is in play (once per message).
      const hier = yield* hierarchyOptions()
      if (hier) {
        for (const rule of rulesForFile(hier, target)) {
          if (sys.has(rule.path) || already.has(rule.path)) continue
          let set = s.claims.get(messageID)
          if (!set) {
            set = new Set()
            s.claims.set(messageID, set)
          }
          if (set.has(rule.path)) continue
          set.add(rule.path)
          results.push({ filepath: rule.path, content: `Instructions from: ${rule.path}\n${rule.content}` })
        }
      }

      return results
    })

    return Service.of({ clear, systemPaths, system, find, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient],
})

export * as Instruction from "./instruction"
