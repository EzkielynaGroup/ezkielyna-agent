import { describe, expect, test } from "bun:test"
import { canDisconnectProvider, providerDisconnectOutcome } from "./provider-source"

describe("provider credential source after disconnect", () => {
  test("does not offer disconnect for environment or file-config credentials", () => {
    for (const source of ["env", "config"]) {
      expect(
        canDisconnectProvider({
          providerID: "ezkielyna",
          builtInProviderID: "ezkielyna",
          source,
          configuredCustomProvider: false,
          legacyConfigSupported: true,
        }),
      ).toBe(false)
    }
  })

  test("reconciles post-disconnect state from fresh provider results", () => {
    expect(providerDisconnectOutcome({ exists: false })).toBe("disconnected")
    expect(providerDisconnectOutcome({ exists: true, source: "env" })).toBe("still-configured")
    expect(providerDisconnectOutcome({ exists: true, source: "config" })).toBe("still-configured")
    expect(providerDisconnectOutcome({ exists: true, source: "api" })).toBe("still-connected")
  })
})
