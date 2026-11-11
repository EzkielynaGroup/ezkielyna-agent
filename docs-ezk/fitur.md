# Fitur

Tanda **(segera)** berarti fitur itu belum ada di versi ini, atau belum kami pastikan berjalan. Tanda **(eksperimental, mati secara bawaan)** berarti fitur ada di kode tetapi harus dinyalakan sendiri, dan belum kami rekomendasikan untuk folder berisi data penting.

## Auto (Pintar): pilih model otomatis

Di daftar model, pilih **Auto (Pintar)**. Untuk setiap pesan, aplikasi menilai tingkat kesulitan tugas lalu memilih model dari yang boleh dipakai kunci Anda:

- tugas **ringan** (tanya, ganti nama, terjemah singkat) → model Flash yang cepat dan murah
- tugas **berat** (refactor banyak file, cari bug sulit, bikin aplikasi) → model yang lebih kuat, kalau kunci Anda punya

Penilaian ini jalan di komputer Anda, tanpa memanggil model. Kalau ragu, aplikasi condong ke "berat".

Paksa untuk satu pesan dengan awalan di awal pesan:
```
@heavy cari kenapa test checkout kadang gagal
@light ganti nama variabel tmp jadi buffer
```
Kalau model gagal (misalnya 403 atau timeout), aplikasi pindah sekali ke model sehat berikutnya dan menampilkan alasannya di label kecil dekat nama model. Model yang gagal "didinginkan" 2 sampai 30 menit.

Mematikan router: `EZK_FEATURES=-router` (variabel lingkungan).

## Mengunci (pin) satu model

Pilih model tertentu di daftar model (bukan Auto). Model itu dipakai terus dan tidak pernah dialihkan. Di CLI: `/pin`. Lihat keputusan terakhir dengan `/route`, kembali ke otomatis dengan `/auto`.

## Batas biaya

Router punya batas biaya per sesi, bawaan **$1**. Lewat batas, giliran berikutnya dialihkan ke model Flash termurah dan labelnya menyebutkan "cost cap". Ubah di `~/.config/ezkielyna/ezkielyna.json`:
```json
{ "ezk": { "router": { "capUSD": 2 } } }
```
`0` berarti tanpa batas. Angka biaya adalah perkiraan dari daftar harga publik.

## Memori

Aplikasi bisa mengingat hal kecil tentang Anda dan proyek (file `MEMORY.md` dan `USER.md`, sangat singkat), misalnya "saya pakai bahasa Indonesia". Tersimpan hanya di komputer Anda. Anda bisa melihat dan menghapus catatan di dialog **Memory** (desktop) atau `/memory` (CLI). Kata sandi, kunci, dan nomor kartu tidak pernah disimpan.

- **Hapus semua**: tombol **Erase memory** (desktop), atau `ezkielyna memory wipe`.
- **Sesi pribadi**: aktifkan **Private session** (desktop) atau `/private`. Pada sesi itu memori tidak dibaca, tidak ditulis, dan sesi tidak ikut pencarian.
- Matikan total: `EZK_FEATURES=-memory`.

## Cari riwayat

Cari percakapan lama dari dialog **Search sessions** (desktop) atau `/search kata kunci` (CLI). Pencarian lokal, tidak ada yang dikirim keluar. Sesi pribadi tidak muncul.

## Pencarian web gratis

Jika Anda punya kunci Ezkielyna, asisten bisa mencari di web lewat alat `web_search`. Gratis untuk semua pemegang kunci.

- Hanya kata kunci pencarian yang dikirim, ke server kami sendiri. Tidak ada file atau isi folder yang ikut terkirim.
- Hasilnya daftar pendek (judul, URL, cuplikan). Untuk membaca satu halaman, asisten memakai `webfetch`.
- **Batas:** 30 pencarian per menit dan 500 per hari untuk setiap kunci. Saat batas tercapai, asisten berhenti mencari dan melanjutkan dengan informasi yang sudah ada. Satu pencarian maksimal 10 hasil, kata kunci 1-400 karakter, dan waktu tunggu 15 detik.
- **Izin:** di mode **Tanya dulu** (bawaan), aplikasi bertanya pada pencarian pertama di sesi itu, dan Anda bisa memilih **selalu izinkan web_search**. Bila mode izin dinyalakan (eksperimental), pencarian jalan tanpa bertanya di **Edit otomatis** dan **Otomatis-aman** (di folder dipercaya).
- Tanpa kunci, alat ini tidak muncul. Matikan dengan `EZK_FEATURES=-websearch`.

## Skills

Asisten menampilkan daftar skill Anda (nama dan satu baris deskripsi) dan baru memuat isi lengkap sebuah skill saat dipakai. Daftar dibatasi sekitar 8.000 karakter. Skill di `.claude/skills` dan `.agents/skills` hanya dibaca di folder yang Anda percaya (`ezkielyna trust`). Skill yang diusulkan asisten setelah tugas tetap menunggu di antrean persetujuan (`/skills`). Pembantu yang mengusulkannya kini memakai model cepat termurah yang diizinkan kunci Anda, jadi kunci yang hanya punya model cepat juga bisa.

## Instruksi: AGENTS.md dan CLAUDE.md (eksperimental, mati secara bawaan)

Aktifkan `+context.hierarchy` (di `EZK_FEATURES` atau kunci `ezk` pada `ezkielyna.json`) agar asisten membaca instruksi Anda berurutan: file milik Anda (`~/.config/ezkielyna/AGENTS.md`), lalu tiap folder dari akar proyek sampai folder Anda sekarang, lalu file pribadi `*.local.md`. `AGENTS.md` dan `CLAUDE.md` sama-sama dibaca; `AGENTS.override.md` menggantikannya di foldernya.
- `@path/ke/file.md` menyisipkan file lain (maksimal 4 tingkat). Hanya file `.md`, `.mdc`, atau `.txt` di dalam proyek; file rahasia atau terlindungi (`.env`, `.git/...`, kunci, pengaturan proyek) tidak pernah disisipkan, dan jumlah total isi sisipan dibatasi.
- File `rules/*.md` dengan `paths: ["src/**/*.ts"]` di bagian atas hanya berlaku saat asisten menyentuh file yang cocok.
- `<!-- komentar -->` dibuang. Totalnya dibatasi 32 KiB, dan ada catatan jika ada teks yang terpotong.
- Di folder yang belum dipercaya (`ezkielyna trust`), file proyek dilewati. File milik Anda tetap berlaku.

## Awal sesi dan perbaikan bug (eksperimental, mati secara bawaan)

`+context.session` menambahkan catatan singkat di pesan pertama: pohon folder kecil, versi alat Anda (node, bun, python, go, cargo), dan perintah untuk memeriksa proyek (test, tipe, lint). Di folder yang belum dipercaya, pemeriksaan versi manajer paket proyek dilewati. `+context.reproduce` menambahkan pengingat tiga langkah saat pesan Anda meminta perbaikan bug: buat ulang masalahnya dulu, temukan baris yang tepat, ubah seminimal mungkin.

## `/review`

`/review` dan `ezkielyna review` selalu ada. Format rubrik P0 sampai P3 di model cepat dipakai `ezkielyna review` (terminal) selalu, dan dipakai `/review` hanya bila `+review` menyala (eksperimental, mati secara bawaan).

Ketik `/review` (desktop atau terminal) atau jalankan `ezkielyna review` untuk mendapat tinjauan kode atas perubahan yang belum di-commit. Target lain: `ezkielyna review --base main`, `ezkielyna review --commit abc123`, atau tambahkan instruksi sendiri (`ezkielyna review "periksa kode login"`). Hasilnya paling banyak 10 temuan bertanda P0 (terburuk) sampai P3, masing-masing dengan `file:baris`. Hanya sekitar 600 baris diff yang dibaca. Berjalan di model cepat yang murah.

## Jembatan Telegram (eksperimental, mati secara bawaan)

Anda bisa menyuruh Ezkielyna dari ponsel lewat bot Telegram **milik Anda sendiri**. Tidak aktif sebelum Anda mengaturnya lewat `ezkielyna gateway telegram`:
1. Buat bot di @BotFather di Telegram, salin token bot.
2. Simpan token di komputer (lewat perintah, bukan di chat), lalu daftarkan ID Telegram Anda ke **allowlist**. Orang lain di luar daftar ditolak.
3. Hanya chat pribadi. Izin (setuju/tolak) muncul sebagai tombol di chat.

## Pencarian kode dan peta repo (eksperimental, mati secara bawaan)

Dua alat bantu untuk proyek besar. **Keduanya mati secara bawaan.**

- **`code_search`** (`EZK_FEATURES=+codesearch`): asisten mencari fungsi, kelas, dan file lewat nama atau kata di komentar, tanpa membaca seluruh proyek. Indeksnya kecil, lokal di komputer Anda, dibuat saat pencarian pertama (sampai puluhan detik di proyek besar, pencarian berikutnya hanya milidetik) dan diperbarui hanya untuk file yang berubah. Tidak ada yang dikirim keluar. Mengerti TypeScript, JavaScript, Python, Go, Rust, dan Java.
- **Peta repo** (`+repomap`): ringkasan sekitar 1.000 token berisi file dan fungsi terpenting, ditambahkan sekali per sesi pada tugas berat di repo git berisi lebih dari 200 file. Hasil uji kami di repo besar belum meyakinkan, jadi sebaiknya tetap mati dulu.

Pemakaian memori: membuat indeks pertama kali menambah sekitar 100 sampai 300 MB sementara, tergantung ukuran proyek.

## Izin, sandbox, dan hooks

Lima mode izin (Tanya dulu, Edit otomatis, Rencana, Otomatis-aman, Penuh), aturan "selalu izinkan", sandbox, dan hooks (semuanya eksperimental, mati secara bawaan), serta folder terlindungi (aktif), dijelaskan di [izin.md](izin.md).

## Mundur, rencana, latar belakang, dan otomasi

`/rewind`, persetujuan rencana, `/handoff`, subagen Explore, dan tugas latar belakang (eksperimental, mati secara bawaan), serta `ezkielyna exec --json` untuk CI, `ezkielyna doctor`, `/context`, dan `/usage` (aktif), dijelaskan di [alur-kerja.md](alur-kerja.md).

## Meringkas percakapan (eksperimental, mati secara bawaan)

Dengan `EZK_FEATURES=+compaction`, percakapan panjang diringkas di sekitar 90% jendela konteks model: hasil alat yang lama dibuang lebih dulu, lalu model cepat menulis ringkasan konteks; sekitar 20.000 token pesan Anda yang terbaru, instruksi proyek, memori, rencana yang disetujui, dan 5 file terakhir dimasukkan lagi. Setelah 3 kegagalan berturut-turut ia berhenti mencoba. Ketik `/compact <fokus>` untuk mengarahkan ringkasan (misalnya `/compact keputusan desain`).

## Folder dipercaya (`ezkielyna trust`)

Folder proyek yang dibuka bisa membawa plugin, instruksi, hooks, atau aturan izin sendiri. Untuk keamanan, semuanya diabaikan sampai Anda menjalankan di folder itu:
```
ezkielyna trust
```
Bila mode izin dinyalakan (eksperimental, mati secara bawaan), di folder yang belum dipercaya semua mode kecuali Rencana dipaksa menjadi Tanya dulu. Aplikasi desktop juga punya spanduk untuk mempercayai folder dan daftar folder dipercaya di Pengaturan. Detailnya di [izin.md](izin.md).

## Izin "tanya dulu"

Sebelum mengedit file atau menjalankan perintah yang belum diizinkan, aplikasi berhenti dan bertanya. Pilihannya: **sekali**, **selalu** (untuk pola itu), atau **tolak**. Pilih "selalu" hanya untuk perintah yang Anda pahami. Mode lain, aturan, dan hal yang tidak pernah bisa disimpan sebagai "selalu" (eksperimental) ada di [izin.md](izin.md).
