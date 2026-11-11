import type { Baris } from "./parser"

export function rekapPerBulan(baris: Baris[]) {
  const rekap = new Map<string, number>()
  for (const b of baris) rekap.set(b.tanggal.slice(0, 7), (rekap.get(b.tanggal.slice(0, 7)) ?? 0) + b.nominal)
  return [...rekap.entries()].sort(([a], [b]) => a.localeCompare(b))
}
