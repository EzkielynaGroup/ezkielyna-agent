import { formatPrice as price } from "../money"

export function receiptEmail(total: number) {
  return `Thanks! You paid ${price(total)}.`
}
