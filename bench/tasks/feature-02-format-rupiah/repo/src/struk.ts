import { formatTanggal } from "./format"

export type Baris = { nama: string; harga: number }

export function cetakStruk(tanggal: Date, baris: Baris[]) {
  const total = baris.reduce((jumlah, item) => jumlah + item.harga, 0)
  return [formatTanggal(tanggal), ...baris.map((item) => `${item.nama}: Rp${item.harga}`), `TOTAL: Rp${total}`].join("\n")
}
