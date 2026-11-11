Callers of `formatPrice` from `src/money.ts`:
- `cartSummary` in `src/cart.ts`
- `invoiceLine` in `src/invoice.ts` (called as `money.formatPrice`)
- `receiptEmail` in `src/emails/receipt.ts` (imported under the alias `price`)

Not affected: `conversionRate` in `src/admin.ts` only uses `formatPercent`, and `exportRow` in `src/legacy/oldPrice.ts` calls its own local `formatPrice`.
