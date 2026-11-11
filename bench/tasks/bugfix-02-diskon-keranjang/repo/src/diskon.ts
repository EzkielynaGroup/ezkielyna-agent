/** Mengembalikan BESAR POTONGAN (dalam rupiah) untuk nominal dan persen diskon tertentu. */
export function terapkanDiskon(nominal: number, persen: number) {
  if (persen < 0 || persen > 100) throw new RangeError("persen harus 0-100")
  return nominal - (nominal * persen) / 100
}
