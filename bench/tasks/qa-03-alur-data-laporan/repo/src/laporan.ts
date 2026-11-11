export function renderLaporan(rekap: [string, number][], jumlahDitolak: number) {
  const baris = rekap.map(([bulan, total]) => `<tr><td>${bulan}</td><td>${total}</td></tr>`).join("")
  return `<table>${baris}</table><p>${jumlahDitolak} baris ditolak</p>`
}
