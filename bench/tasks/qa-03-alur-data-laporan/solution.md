1. `src/main.ts` membaca file lalu memanggil `terimaUpload` (`src/upload.ts`).
2. `parseCsv` (`src/parser.ts`) memecah teks per baris (header dibuang) menjadi `{ mentah, tanggal, nominal }`.
3. `validasiBaris` (`src/validasi.ts`) memisahkan baris valid (tanggal YYYY-MM-DD, nominal angka >= 0) dari yang ditolak.
4. Baris yang ditolak tidak ikut dihitung; teks aslinya ditulis ke `ditolak.csv` dan jumlahnya ditampilkan di laporan.
5. `rekapPerBulan` (`src/agregasi.ts`) menjumlahkan nominal per bulan (YYYY-MM), terurut.
6. `renderLaporan` (`src/laporan.ts`) membuat tabel HTML, yang ditulis `main.ts` ke `laporan.html`.
