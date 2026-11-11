// Ezkielyna Agent Wave B T4(a): the LSP navigation tool (definition / references / hover / ...) is offered to the
// model only while a language server is attached. Added next to the registry tools so tool/registry.ts stays untouched.
import { Effect } from "effect"
import { speedEnabled } from "@opencode-ai/core/ezk/speed/flags"
import { LSP } from "@/lsp/lsp"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { LspTool } from "@/tool/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { existsSync } from "node:fs"

// The LSP tool only calls existsSafe, so a tiny service keeps `resolve` free of an extra FSUtil requirement.
const minimalFs = { existsSafe: (p: string) => Effect.sync(() => existsSync(p)) } as unknown as FSUtil.Interface

export const lspNavTools = (alreadyOn: boolean) =>
  Effect.gen(function* () {
    if (!speedEnabled("code-intel") || alreadyOn) return [] as Tool.Def[]
    const found = yield* Effect.serviceOption(LSP.Service)
    const trunc = yield* Effect.serviceOption(Truncate.Service)
    const agents = yield* Effect.serviceOption(Agent.Service)
    if (found._tag === "None" || trunc._tag === "None" || agents._tag === "None") return [] as Tool.Def[]
    const lsp = found.value
    const attached = yield* lsp.status()
    if (attached.length === 0) return [] as Tool.Def[]
    const built = Effect.gen(function* () {
      return yield* Tool.init(yield* LspTool)
    }).pipe(
      Effect.provideService(LSP.Service, lsp),
      Effect.provideService(Truncate.Service, trunc.value),
      Effect.provideService(Agent.Service, agents.value),
    )
    return [yield* built] as Tool.Def[]
  }).pipe(Effect.provideService(FSUtil.Service, minimalFs))
