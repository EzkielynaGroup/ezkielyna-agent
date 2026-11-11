export function canDisconnectProvider(input: {
  providerID: string
  builtInProviderID: string
  source?: unknown
  configuredCustomProvider: boolean
  legacyConfigSupported: boolean
}) {
  const manualCredential = input.source === "api" || input.source === "custom"
  const removableCustomConfig = input.configuredCustomProvider && input.providerID !== input.builtInProviderID
  return (manualCredential || removableCustomConfig) && (input.legacyConfigSupported || !input.configuredCustomProvider)
}

export function providerDisconnectOutcome(input: { exists: boolean; source?: unknown }) {
  if (!input.exists) return "disconnected" as const
  if (input.source === "config" || input.source === "env") return "still-configured" as const
  return "still-connected" as const
}
