import { formatPercent } from "./money"

export function conversionRate(orders: number, visits: number) {
  return formatPercent(orders / visits)
}
