# Mulai cepat

Ezkielyna Agent adalah asisten AI yang bisa membaca file, mengedit, dan menjalankan perintah di komputer Anda. Ada dua cara memakainya: **aplikasi desktop** atau **CLI** (di terminal). Pilih salah satu, atau pakai keduanya.

## 1. Pasang aplikasi desktop

Unduh dari halaman unduhan: https://ezkielyna.store/agent

**macOS**
1. Buka file `.dmg`, seret **Ezkielyna Agent** ke folder Applications.
2. Saat pertama dibuka, macOS bisa menolak karena aplikasi belum dinotarisasi Apple. Klik kanan ikon aplikasi → **Open** → **Open**. Cukup sekali.
3. Kalau tetap diblokir, buka Terminal lalu jalankan:
   ```
   xattr -dr com.apple.quarantine "/Applications/Ezkielyna Agent.app"
   ```
   Lalu buka lagi aplikasinya.

**Windows**
1. Jalankan file installer `.exe`.
2. Jika muncul layar biru "Windows protected your PC", klik **More info** → **Run anyway**.

**Linux**
- **AppImage**: `chmod +x Ezkielyna-Agent-*.AppImage` lalu jalankan `./Ezkielyna-Agent-*.AppImage`.
- **deb** (Debian/Ubuntu): `sudo apt install ./ezkielyna-agent_*.deb`
- Build Linux untuk aplikasi desktop belum selalu tersedia di setiap rilis (segera). CLI selalu bisa dipakai di Linux.

## 2. Pasang CLI (terminal)

macOS, Linux, WSL:
```
curl -fsSL https://ezkielyna.store/agent/install.sh | sh
```

Windows (PowerShell):
```
irm https://ezkielyna.store/agent/install.ps1 | iex
```

Installer tidak butuh sudo/admin, memeriksa tanda tangan dan SHA-256 sebelum memasang, dan menaruh program di `~/.ezkielyna`. Setelah selesai, buka terminal baru dan ketik `ezkielyna` (singkatnya `ezk`).

## 3. Masuk pertama kali

Anda butuh **kunci API** (berawalan `sk-`). Buat di https://api.ezkielyna.store/keys.

- **Dengan kunci**: saat pertama dibuka, pilih penyedia Ezkielyna, lalu tempel kunci. Di CLI: `ezkielyna providers login`.
- **Masuk dengan akun Ezkielyna** (login lewat browser, tanpa menempel kunci): *(segera)*. Pilihan ini baru muncul setelah sisi server siap.

Kunci disimpan di komputer Anda. Jangan kirim kunci ke siapa pun, termasuk ke support.

## 4. Tugas pertama

Pilih folder proyek, lalu ketik permintaan biasa. Contoh:

- `Jelaskan apa fungsi file config.ts`
- `Perbaiki typo di README.md`
- `Buatkan fungsi untuk memformat angka jadi rupiah`

Sebelum mengubah file atau menjalankan perintah, Ezkielyna akan **bertanya dulu**. Baca, lalu pilih izinkan atau tolak. Pilihan model: biarkan di **Auto (Pintar)** dulu, lihat [fitur.md](fitur.md).
