import * as money from "./money"

export function invoiceLine(name: string, cents: number) {
  return `${name.padEnd(20)}${money.formatPrice(cents)}`
}
