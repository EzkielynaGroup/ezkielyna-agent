const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"]

export function formatTanggal(tanggal: Date) {
  return `${tanggal.getUTCDate()} ${BULAN[tanggal.getUTCMonth()]} ${tanggal.getUTCFullYear()}`
}
