# Masalah umum

## Kunci tidak valid (401)
- Salin ulang kunci utuh dari https://api.ezkielyna.store/keys. Pastikan tidak ada spasi di awal/akhir dan berawalan `sk-`.
- Jika kunci sudah dihapus atau dinonaktifkan, buat yang baru lalu masuk lagi (`ezkielyna providers login`).

## Saldo atau kuota habis (402 / 403)
- Cek saldo atau sisa kuota di akun Anda di https://ezkielyna.store, lalu isi ulang atau tunggu kuota diperbarui.
- Dalam mode **Auto (Pintar)**, aplikasi akan mencoba model lain dulu. Kalau semua ditolak, hasilnya tetap error.

## Terlalu banyak permintaan (429)
Tunggu sebentar lalu coba lagi. Jangan jalankan banyak sesi sekaligus dengan satu kunci. Dalam mode Auto, aplikasi pindah otomatis ke model lain.

## Model tidak tersedia / "no available channel" (404, 503)
Model itu sedang tidak aktif atau bukan bagian dari kunci Anda. Pilih model lain, atau pakai **Auto (Pintar)**. Cek https://ezkielyna.store/status.

## Jawaban tidak muncul
Jika model tidak mulai menjawab dalam 25 detik, Auto (Pintar) pindah ke model berikutnya. Kalau Anda mengunci satu model, coba model lain.

## Aplikasi tidak mau dibuka
- **macOS**: klik kanan aplikasi → **Open** → **Open**. Jika masih diblokir: `xattr -dr com.apple.quarantine "/Applications/Ezkielyna Agent.app"`.
- **Windows**: **More info** → **Run anyway**. Jika antivirus menghapus file, unduh ulang dan izinkan.
- **Linux AppImage**: pastikan sudah `chmod +x`.
- Masih gagal: pasang CLI (lihat [mulai.md](mulai.md)); CLI tidak butuh jendela aplikasi.

## `ezkielyna: command not found`
Buka terminal baru. Jika masih, tambahkan ke profil shell: `export PATH="$HOME/.ezkielyna/bin:$PATH"`.

## Sandbox memblokir sesuatu (hanya bila sandbox dinyalakan: eksperimental, mati secara bawaan)
Gejala: perintah gagal dengan "Read-only file system", "Operation not permitted", atau galat jaringan (misalnya `npm install` tidak bisa mengunduh), dan ada catatan bahwa perintah "berjalan di sandbox dan kemungkinan diblokir".
- Itu normal: sandbox hanya mengizinkan menulis di folder proyek dan folder sementara, dan tidak mengizinkan jaringan. Folder seperti `.git`, `.claude`, `.ssh`, `.aws` selalu hanya-baca.
- Biarkan asisten meminta. Ia akan menampilkan kartu persetujuan **jaringan sekali ini** atau **di luar sandbox sekali ini**, lengkap dengan alasannya. Setujui hanya jika Anda paham perintahnya.
- Mematikan sandbox: `EZK_FEATURES=-sandbox`. Di Linux, tips "pasang bubblewrap" berarti sandbox belum aktif karena `bubblewrap` belum terpasang. Di Windows tidak ada sandbox.
- Lihat [izin.md](izin.md).

## Sebuah hook memblokir langkah (hanya bila `+hooks` dinyalakan: eksperimental, mati secara bawaan)
Gejala: asisten bilang langkahnya diblokir dan mengutip alasan, atau tidak mau berhenti karena "test masih gagal".
- Alasan itu adalah teks yang ditulis hook Anda ke stderr (keluar dengan kode 2). Baca skrip hook-nya di bagian `hooks` pada `.ezkielyna/settings.json`, `.claude/settings.json`, atau `~/.config/ezkielyna/settings.json`.
- Hook `Stop` yang terus memblokir diabaikan sendiri setelah 8 kali berturut-turut.
- Hook proyek hanya jalan di folder dipercaya. Hook yang "tidak jalan" biasanya karena folder belum dipercaya (`ezkielyna trust`), atau `+hooks` belum menyala. Hook yang melewati 60 detik dihentikan.
- Sementara, matikan semua hooks dengan menghapus `+hooks` dari `EZK_FEATURES`.
- Lihat [izin.md](izin.md).

## Batas pencarian web tercapai
Gejala: asisten berkata pencarian ditolak (kode 429) lalu melanjutkan tanpa mencari.
- Batasnya 30 pencarian per menit dan 500 per hari untuk setiap kunci. Tunggu semenit, atau sampai besok bila batas harian habis.
- Pesan "kunci tidak valid" (401) berbeda: periksa kunci Anda (lihat "Kunci tidak valid" di atas).
- Anda bisa menyuruh asisten memakai halaman yang sudah Anda tempel, atau `webfetch` ke satu alamat tertentu.

## Memeriksa pemasangan dengan `ezkielyna doctor`
Jalankan `ezkielyna doctor` dan baca satu baris per pemeriksaan: `✓` baik, `!` peringatan, `✗` gagal.
- **Kunci API**: harus "ada". Jika tidak, masuk lagi dengan `ezkielyna providers login`. Kunci tidak pernah dicetak.
- **Koneksi**: jika gagal, periksa internet, VPN, atau proxy, lalu https://ezkielyna.store/status.
- **Folder ini belum dipercaya**: instruksi dan hooks proyek diabaikan. Jalankan `ezkielyna trust` jika Anda yang membuat proyek itu.
- **Ruang disk** rendah: kosongkan ruang.
- **Pembaruan** "mati": unduh versi baru dari ezkielyna.store.
- Untuk support: kirim keluaran `doctor` (aman dibagikan, kunci tidak ikut). Tetap baca sekilas sebelum mengirim.

## Mengirim log ke support tanpa membocorkan kunci
1. Kirim **versi** (`ezkielyna --version`), sistem operasi, dan **teks error** yang tampil.
2. Kalau perlu log, ambil file di folder log: `~/.local/share/ezkielyna/log/`. **Buka dulu dengan editor teks dan cari "sk-"**; hapus apa pun yang mirip kunci sebelum mengirim.
3. Jangan kirim file `auth.json`, isi `~/.config/ezkielyna/`, atau tangkapan layar halaman kunci.
4. Kalau kunci sempat terkirim, hapus kunci itu di https://api.ezkielyna.store/keys lalu buat yang baru.
