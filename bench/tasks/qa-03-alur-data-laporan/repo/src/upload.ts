import { parseCsv } from "./parser"
import { validasiBaris } from "./validasi"
import { rekapPerBulan } from "./agregasi"
import { renderLaporan } from "./laporan"

export async function terimaUpload(file: Blob) {
  const baris = parseCsv(await file.text())
  const { valid, ditolak } = validasiBaris(baris)
  if (ditolak.length) await Bun.write("ditolak.csv", ditolak.map((b) => b.mentah).join("\n"))
  return renderLaporan(rekapPerBulan(valid), ditolak.length)
}
