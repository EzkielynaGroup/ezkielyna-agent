# Privasi

Tidak ada telemetri. Aplikasi hanya menghubungi gateway Ezkielyna (`api.ezkielyna.store`), dan situs unduhan untuk memeriksa pembaruan.

## Tetap di komputer Anda
- **Memori**: `~/.config/ezkielyna/memory/` (`MEMORY.md`, `USER.md`).
- **Pencarian riwayat**: indeks `~/.local/share/ezkielyna/ezk/search.db`.
- **Sesi dan percakapan**: di basis data lokal di `~/.local/share/ezkielyna/`.
- **Catatan keputusan router**: `route-turns.jsonl` (hanya model yang dipilih, tanpa isi pesan). Log keputusan yang lebih rinci mati secara bawaan dan tidak pernah diunggah.
- Kunci API Anda.

Semua file itu hanya bisa dibaca pemilik akun komputer (mode 0600).

## Yang dikirim ke gateway
- Pesan Anda, isi file/keluaran perintah yang diminta model, dan prompt sistem. Itu perlu agar model bisa menjawab.
- Catatan memori ikut dikirim **sebagai bagian dari prompt** ke gateway yang Anda pakai, bukan ke tempat lain.
- Satu panggilan latar: peninjau memori memakai model Flash (paling banyak 40 kali per hari, bisa dimatikan dengan `EZK_FEATURES=-memory`).
- Daftar model dan harga dibaca dari gateway/situs (publik).

Jangan menempel kata sandi atau kunci di chat. Pemindai memori menolak menyimpannya, tetapi yang Anda ketik tetap dikirim ke model.

## Menghapus semuanya
- Memori dan indeks pencarian: `ezkielyna memory wipe` (tambahkan `--all` untuk data router, `--yes` agar tanpa konfirmasi), atau tombol **Erase memory** di aplikasi desktop.
- Riwayat percakapan: hapus sesi dari daftar sesi, atau hapus folder `~/.local/share/ezkielyna/`.
- Semua pengaturan dan kunci: hapus `~/.config/ezkielyna/` dan keluar (logout) dari penyedia.
- CLI: hapus `~/.ezkielyna`. Desktop: seret aplikasi ke Sampah / uninstall biasa.
