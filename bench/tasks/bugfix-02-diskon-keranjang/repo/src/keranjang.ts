import { terapkanDiskon } from "./diskon"

export type Item = { nama: string; harga: number; jumlah: number }

/** Total belanja setelah diskon persen, dibulatkan ke rupiah terdekat. */
export function hitungTotal(items: Item[], diskonPersen = 0): number {
  const subtotal = items.reduce((jumlah, item) => jumlah + item.harga * item.jumlah, 0)
  const potongan = terapkanDiskon(subtotal, diskonPersen)
  return Math.round(subtotal - potongan)
}
