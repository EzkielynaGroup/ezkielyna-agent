// Old helper kept for the CSV export; unrelated to src/money.ts.
export function formatPrice(value: number) {
  return value.toFixed(2)
}

export function exportRow(value: number) {
  return formatPrice(value)
}
