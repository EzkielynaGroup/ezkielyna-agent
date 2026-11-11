import { expect, test } from "bun:test"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import type { Provider } from "@/provider/provider"
import { usable } from "../../src/session/overflow"

test("Ezk model-policy agentContext compacts at 90 percent while legacy fallback is unchanged", () => {
  const metadataModel = {
    providerID: EZK.providerID,
    limit: { context: 200_000, input: 200_000, output: 128_000 },
  } as Provider.Model
  expect(usable({ cfg: {} as ConfigV1.Info, model: metadataModel })).toBe(180_000)

  const fallbackModel = {
    providerID: EZK.providerID,
    limit: { context: 128_000, input: 100_000, output: 16_384 },
  } as Provider.Model
  expect(usable({ cfg: {} as ConfigV1.Info, model: fallbackModel })).toBe(83_616)
})
