import { formatPrice } from "./money"

export function cartSummary(items: { cents: number }[]) {
  return `${items.length} items, ${formatPrice(items.reduce((total, item) => total + item.cents, 0))}`
}
