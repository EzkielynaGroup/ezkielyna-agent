// Dry-run gateway for `bench/run.ts --dry-run`: the shared Ezkielyna mock gateway from packages/core/test/ezk
// (/v1/models, /api/pricing, scripted /v1/chat/completions, title requests answered separately), scripted to play
// a minimal agent. Every model it lists gets the same two steps:
//   1. one shell tool call running `script` (the task's reference solution, copied into the workspace by the runner,
//      or a harmless `ls` for Q&A tasks);
//   2. a final text `answer`, which ends the turn.
// If the router escalates mid-task the new model replays both steps; reference solutions are idempotent.
// Usage includes cached prompt tokens so token, cost and cache-hit accounting are exercised. No network, no key.
import { STATIC_PRICES } from "../../packages/core/src/ezk/pricing"
import { startMockGateway } from "../../packages/core/test/ezk/mock-gateway"

/** Models served by the mock: the gateway aliases plus every model the router may pick. */
export const DRY_RUN_MODELS = ["auto", "default-model", ...Object.keys(STATIC_PRICES)]
let nextPort = 30_000 + (process.pid % 20_000)

export function startDryRunGateway(input: { script: string; answer: string; model?: string }) {
  const models = [...new Set([...DRY_RUN_MODELS, ...(input.model ? [input.model] : [])])]
  const steps = () => [
    {
      ok: true as const,
      tool: { name: "bash", args: { command: input.script, description: "Run the reference solution" } },
      usage: { prompt: 1500, completion: 60, cached: 900 },
    },
    { ok: true as const, text: input.answer, usage: { prompt: 1700, completion: 80, cached: 1400 } },
  ]
  let mock: ReturnType<typeof startMockGateway> | undefined
  for (let attempt = 0; attempt < 128 && !mock; attempt++) {
    const port = nextPort
    nextPort = nextPort >= 59_999 ? 30_000 : nextPort + 1
    try {
      mock = startMockGateway({
        port,
        models: { "*": models },
        script: Object.fromEntries(models.map((id) => [id, steps()])),
      })
    } catch (error) {
      if (!String(error).includes("EADDRINUSE")) throw error
    }
  }
  if (!mock) throw new Error("could not allocate a local mock-gateway port after 128 attempts")
  const started = mock
  return { url: started.baseURL, requests: started.requests, stop: () => started.stop() }
}
