export function animatedNumberAccessibility(value: number) {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
  return {
    value: normalized,
    text: normalized.toString(),
    hideVisual: true,
  } as const
}
