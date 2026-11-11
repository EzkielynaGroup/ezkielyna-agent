export function formatPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`
}

export function formatPercent(ratio: number) {
  return `${Math.round(ratio * 100)}%`
}
