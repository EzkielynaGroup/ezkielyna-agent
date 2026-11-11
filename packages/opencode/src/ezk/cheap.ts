// Ezkielyna Agent v3: one short text call on the cheapest model of the key's light chain (design rule 3: side work
// runs on Flash). Used by "summarise from here" (/rewind) and /handoff. Falls back to the session's own model when the
// key's model list is unknown, so it also works with other providers.
import { Effect } from "effect"
import { generateText } from "ai"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { subagentModel } from "@opencode-ai/core/ezk/ux/subagents"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"

export const cheapText = Effect.fn("EzkUx.cheapText")(function* (input: {
  system: string
  prompt: string
  maxOutputTokens: number
  /** the session's model, used when no light model is known for this key */
  fallback?: { providerID: string; modelID: string }
}) {
  const provider = yield* Provider.Service
  const model = yield* pickModel(input.fallback)
  if (!model) return yield* Effect.fail(new Error("no model available for this step"))
  const resolved = yield* provider.getModel(ProviderV2.ID.make(model.providerID), ModelV2.ID.make(model.modelID))
  const language = yield* provider.getLanguage(resolved)
  const result = yield* Effect.tryPromise({
    try: () => generateText({ model: language, system: input.system, prompt: input.prompt, maxOutputTokens: input.maxOutputTokens }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
  return { text: result.text.trim(), model: model.modelID }
})

/** The light model for subagent/side work on this key, or undefined (keep the caller's model). */
export const lightModel = Effect.fn("EzkUx.lightModel")(function* (tier: "light" | "heavy" = "light") {
  const { ezkRuntime } = yield* Effect.promise(() => import("@/plugin/ezk/runtime"))
  const rt = ezkRuntime()
  yield* Effect.promise(() => rt.ensureAllowed().catch(() => undefined))
  const id = subagentModel({
    tier,
    policy: rt.engine.policy,
    allowed: rt.engine.allowed,
    price: (m) => {
      const p = rt.prices.get(m)
      return p ? p.ratio * (p.groupRatio || 1) : undefined
    },
  })
  return id ? { providerID: EZK.providerID, modelID: id } : undefined
})

const pickModel = Effect.fn("EzkUx.pickModel")(function* (fallback?: { providerID: string; modelID: string }) {
  if (fallback && fallback.providerID !== EZK.providerID) return fallback
  return (yield* lightModel("light")) ?? fallback
})
