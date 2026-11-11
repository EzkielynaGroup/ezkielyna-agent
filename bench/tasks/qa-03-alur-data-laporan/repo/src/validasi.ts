import type { Baris } from "./parser"

export function validasiBaris(baris: Baris[]) {
  const ok = (b: Baris) => /^\d{4}-\d{2}-\d{2}$/.test(b.tanggal) && Number.isFinite(b.nominal) && b.nominal >= 0
  return { valid: baris.filter(ok), ditolak: baris.filter((b) => !ok(b)) }
}
