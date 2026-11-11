export type Baris = { mentah: string; tanggal: string; nominal: number }

export function parseCsv(teks: string): Baris[] {
  return teks
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((mentah) => {
      const [tanggal = "", nominal = ""] = mentah.split(",")
      return { mentah, tanggal, nominal: Number(nominal) }
    })
}
