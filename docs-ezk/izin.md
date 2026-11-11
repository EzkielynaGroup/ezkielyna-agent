# Izin, sandbox, dan hooks

Halaman ini menjelaskan cara Ezkielyna Agent meminta izin sebelum mengubah file atau menjalankan perintah, dan cara Anda mengaturnya. Mode izin otomatis, aturan "selalu izinkan", hooks, dan sandbox di halaman ini **(eksperimental, mati secara bawaan)**. Versi beta tetap bertanya dulu.

Tanda **(segera)** berarti belum ada di versi ini.

> **Catatan versi ini.** Semua yang ada di halaman ini sudah ada di kode, tetapi dipasang dengan saklar `EZK_FEATURES` dan **eksperimental dan mati secara bawaan**. Peninjauan keamanan independen sudah kami tindak lanjuti (aturan "Edit" yang disimpan tidak lagi melewati folder terlindungi; berkas pengaturan proyek kini terlindungi), tetapi fitur ini belum kami rekomendasikan untuk folder berisi data penting. Untuk mencobanya:
> ```
> EZK_FEATURES="+modes,+rules,+hooks"
> ```
> (atau kunci `ezk` di `ezkielyna.json`). Sandbox dan fitur lain punya saklar sendiri, disebut di bagiannya. Tanpa saklar, aplikasi berperilaku seperti sebelumnya: bertanya dulu.

## Lima mode izin (eksperimental, mati secara bawaan)

Seluruh bagian ini hanya berlaku bila `+modes` menyala. Secara bawaan versi ini memakai Tanya dulu.

| Mode | Singkatnya |
|---|---|
| **Tanya dulu** | Bertanya sebelum setiap perubahan, perintah, atau akses web. |
| **Edit otomatis** | Mengubah file di dalam proyek sendiri. Perintah, web, dan apa pun di luar proyek tetap bertanya. **Ini mode bawaan hanya bila** `+modes` menyala. |
| **Rencana** | Hanya membaca. Menyusun rencana, tidak mengubah apa pun. |
| **Otomatis-aman** | Seperti Edit otomatis, ditambah perintah yang sudah Anda izinkan "selalu". (Penyaring otomatis untuk perintah lain, `+safety.classifier`, eksperimental dan mati secara bawaan: model cepat hanya melihat pesan Anda dan panggilan alatnya, dan folder terlindungi, aturan tolak, dan folder yang belum dipercaya selalu menang. Bila ragu atau gagal, ia bertanya; 3 blokir berturut-turut atau 20 total mengembalikan sesi ke Tanya dulu.) |
| **Penuh** | Melakukan semuanya tanpa bertanya. Pakai hanya di folder yang benar-benar Anda percaya. |

### Cara berganti mode

- Hanya bila `+modes` menyala (kecuali `--permission-mode`, yang menyalakannya untuk proses itu).
- **Terminal:** tekan **Shift+Tab**. Urutannya Tanya dulu → Edit otomatis → Rencana → Otomatis-aman. **Penuh** tidak ikut berputar; harus Anda pilih sendiri.
- **Aplikasi desktop:** pilih mode di pemilih di kotak pesan.
- **Saat memulai:** `ezkielyna --permission-mode edit-otomatis` (juga untuk `ezkielyna run`). Nama yang dikenali: `Tanya dulu`, `edit-otomatis`, `rencana`, `otomatis-aman`, `penuh`, atau `ask`, `acceptEdits`, `plan`, `safeAuto`, `full`. Memakai `--permission-mode` otomatis menyalakan fitur mode (yang eksperimental) untuk proses itu.
- **Tetap di pengaturan:** `"permission": { "mode": "acceptEdits" }` di `ezkielyna.json`.

Urutan prioritas: opsi di perintah, lalu pengaturan, lalu bawaan. Pilihan di satu sesi hanya berlaku untuk sesi itu.

### Apa yang boleh di tiap mode (folder dipercaya)

Tabel ini hanya berlaku bila `+modes` menyala.

| | Tanya dulu | Edit otomatis | Rencana | Otomatis-aman | Penuh |
|---|---|---|---|---|---|
| Membaca, mencari file | ya | ya | ya | ya | ya |
| Mengubah file di dalam proyek | bertanya | **ya** | **tidak** | **ya** | ya |
| Mengubah folder terlindungi (lihat bawah) | bertanya | bertanya | tidak | bertanya | bertanya (alat memaksa) |
| Mengubah file di luar proyek | bertanya | bertanya | tidak | bertanya | ya |
| Perintah baca-saja bawaan (`ls`, `pwd`, `git status`, `git diff`, `git log`, `rg`, `cat`/`head`/`tail` di dalam proyek) | ya | ya | ya | ya | ya |
| Perintah yang cocok dengan aturan "selalu izinkan" | ya | ya | **tidak** | **ya** | ya |
| Perintah lain | bertanya | bertanya | **tidak** | bertanya | ya |
| Membuka halaman web | bertanya | bertanya | bertanya | bertanya | ya |
| Aturan "tolak" yang Anda tulis | selalu menolak | selalu menolak | selalu menolak | selalu menolak | selalu menolak |

Catatan:
- Di **Rencana**, alat untuk mengubah file bahkan disembunyikan dari asisten. Perintah di luar daftar baca-saja ditolak, walau Anda setuju.
- **Penuh** menampilkan peringatan. Aturan "tolak" dan "tanya" yang Anda tulis sendiri tetap berlaku.
- Aturan "selalu izinkan" dan perintah baca-saja yang diperluas (`ls`, `rg`, `git status`, dan sebagainya) butuh saklar `+rules` (eksperimental, mati secara bawaan).
- Setiap kali mode berganti, asisten diberi tahu lewat catatan kecil di pesan Anda, bukan di prompt sistem.

## Aturan "selalu izinkan" (eksperimental, mati secara bawaan)

Saat aplikasi bertanya, pilihannya: **Izinkan sekali**, **Izinkan selalu (sesi ini)**, **Selalu izinkan di proyek ini**, atau **Tolak**.

"Selalu izinkan di proyek ini" menyimpan aturan seperti `Bash(bun test *)` di `.ezkielyna/settings.local.json` (file pribadi, izin 0600, otomatis masuk `.gitignore`). Aturan memakai awalan perintah:

- `bun test *` mengizinkan `bun test`, `bun test src/a.test.ts`, dan seterusnya.
- Perintah gabungan diperiksa per bagian. `bun test; rm -rf ~` **tidak** cocok dengan `bun test *`, karena `rm -rf ~` tidak punya aturan.
- Perintah dengan variabel, substitusi (`$(...)`), heredoc, atau pengalihan ke file tidak pernah diizinkan lewat aturan.
- "Selalu izinkan edit di proyek ini" tersimpan sebagai `Edit(**)` dan **tidak pernah** membuka folder terlindungi (lihat bawah): itu tetap bertanya.
- Aturan **tolak** berbasis awalan adalah usaha terbaik: perintah yang disamarkan dengan sangat licik (tanda kutip bertingkat, kata kunci majemuk) bisa lolos dari pencocokan. Jangan jadikan itu satu-satunya pengaman.

**Tidak pernah disimpan untuk seluruh proyek** (hanya bisa diizinkan sekali): `rm`, `rmdir`, `sudo`, `su`, `dd`, `mkfs`, `chmod`, `chown`, `curl`, `wget`, shell (`sh`, `bash`, `zsh`, ...), interpreter (`python`, `node`, `bun`, `deno`, `perl`, `ruby`, `php`), `eval`, `exec`, `xargs`, `find`, `env`, `ssh`, `scp`, `rsync`, `kill`, `pkill`, `shutdown`, `reboot`, `npx`, `bunx`, serta `git push`, `git reset`, `git clean`, `npm publish`, `bun publish`.

Aturan juga bisa ditulis sendiri di `settings.json` (`permissions.allow`, `permissions.ask`, `permissions.deny`), dengan format yang sama seperti `.claude/settings.json`. Urutannya: tolak, lalu tanya, lalu izinkan; yang cocok pertama menang. Ketik `/permissions` di terminal untuk melihat mode, aturan yang tersimpan (yang lokal bisa dihapus), dan daftar **Baru saja ditolak**.

## Folder terlindungi (aktif)

Alat file (edit, tulis, patch) dan alat shell **selalu bertanya** untuk tempat-tempat ini, walau di dalam proyek, di mode apa pun (juga Penuh, dan walau ada aturan "selalu izinkan"): `.git`, `.ezkielyna`, `.claude`, `.codex`, `.agents`, `.opencode`, `.aws`, `.ssh`, `.gnupg`, `.husky`, `.vscode`, `.idea`, `.mcp.json`, `.npmrc`, `ezkielyna.json(c)`, `opencode.json(c)`, `AGENTS.md`, `CLAUDE.md`, `.github/workflows`, `.env`, dan file `.env.*` (kecuali `.env.example`). Huruf besar-kecil tidak dibedakan, dan jalur lewat symlink ikut diperiksa. Alasannya: mengubah tempat-tempat ini bisa menjadi eksekusi kode atau perubahan instruksi tanpa pertanyaan berikutnya (hook git, pengaturan hooks, perintah di berkas konfigurasi, workflow CI).

Perlindungan lain yang aktif secara bawaan: perintah `git` yang mengubah repo selalu bertanya, dan kunci-kunci rahasia (nama mengandung KEY, TOKEN, SECRET, PASSWORD) dibuang dari lingkungan **warisan** proses anak (shell dan server MCP). Variabel yang Anda isi sendiri (misalnya blok `environment` sebuah server MCP) tetap dikirim apa adanya. Pengecualian untuk yang diwarisi bisa diberi lewat `EZK_ENV_PASSTHROUGH=NAMA1,NAMA2`.

## Folder yang belum dipercaya

Folder proyek bisa membawa instruksi, hooks, dan aturan sendiri. Sampai Anda mempercayainya:

- Semua mode **kecuali Rencana** dipaksa menjadi **Tanya dulu**.
- Aturan "izinkan" dari proyek diabaikan. Aturan "tolak" dan "tanya" tetap berlaku (hanya memperketat).
- Hooks proyek, instruksi proyek, dan skill proyek tidak dibaca.
- Daftar perintah baca-saja yang diperluas tidak berlaku.

Percayai folder dengan menjalankan `ezkielyna trust` di dalamnya. Di aplikasi desktop, folder yang belum dipercaya menampilkan spanduk dengan **Percayai folder ini** atau **Biarkan tidak dipercaya**. Daftar folder dipercaya ada di Pengaturan → Umum, dengan tombol **Hapus**.

## Sandbox (Mac dan Linux) (eksperimental, mati secara bawaan)

Di versi ini sandbox **tidak aktif**: ia mengikuti mode izin yang juga mati. `+sandbox` menyalakannya di semua mode kecuali Penuh.

Sandbox mengurung **perintah shell** di tingkat sistem operasi. Beda dengan izin: izin menanyakan lebih dulu, sandbox membatasi apa yang bisa dilakukan perintah itu setelah jalan.

Yang diizinkan di dalam sandbox:
- menulis di folder proyek, folder sementara, dan folder keluaran/log/sementara aplikasi (bukan seluruh folder data, jadi basis data sesi tidak ikut);
- membaca sebagian besar sistem.

Yang **diblokir**:
- menulis di tempat lain (folder rumah, `~/.ssh`, `/etc`, dan sebagainya);
- menulis ke `.git`, `.ezkielyna`, `.claude`, `.codex`, `.agents`, `.opencode`, `.ssh`, `.aws`, `.gnupg`, `.husky`, `.mcp.json`, `ezkielyna.json(c)` dan `opencode.json(c)`, walau di dalam proyek;
- akses **jaringan** (misalnya `curl`, `npm install`; di Linux soket Unix yang sudah ada, misalnya Docker, masih bisa dijangkau).

Perintah yang butuh itu akan gagal dengan pesan seperti "Read-only file system" atau "Operation not permitted", dan aplikasi menambahkan catatan penjelasan dengan bahasa sederhana. Lalu asisten bisa meminta, dan **Anda yang memutuskan**:

- **Jaringan sekali ini** (`with_network`): perintah yang sama dijalankan lagi dengan jaringan menyala.
- **Di luar sandbox sekali ini** (`require_escalated`): perintah dijalankan tanpa kurungan.

Keduanya muncul sebagai kartu persetujuan dengan perintah dan alasan satu baris dari asisten. Pilih sekali. "Selalu" hanya ditawarkan untuk awalan yang aman diingat (tidak untuk `bash`, `python`, `curl`, dan sejenisnya).

Contoh: asisten menjalankan `npm install`, gagal karena jaringan diblokir, lalu meminta jaringan dengan alasan "memasang dependensi". Anda setuju sekali; setelah itu perintah berikutnya kembali ke sandbox.

**Cara menyalakan:** `EZK_FEATURES=+sandbox` (aktif di semua mode kecuali Penuh), atau mulai dengan `--permission-mode edit-otomatis` / `otomatis-aman`, yang memakai sandbox. Matikan dengan `-sandbox`. Penuh tidak pernah memakai sandbox. Bila `+modes` menyala, sandbox mengikuti mode sesi (Shift+Tab, pemilih desktop, `--permission-mode`). Perintah latar belakang (`+exec`) ikut berjalan di sandbox.

**Linux:** butuh `bubblewrap` (misalnya `sudo apt install bubblewrap`). Tanpa itu, perintah berjalan seperti biasa dengan Tanya dulu, dan muncul satu tips. Batasan: perintah masih bisa **membuat** folder atau berkas baru bernama `.git`, `.claude`, atau `.ezkielyna/settings.json` di proyek (yang sudah ada tetap hanya-baca). Di Mac, itu diblokir.

**Windows:** tidak ada sandbox. Perintah berjalan seperti biasa dengan persetujuan Anda. Hal yang sama berlaku untuk PowerShell dan cmd di sistem lain.

Batasan di semua sistem: sandbox **tidak melarang membaca** (perintah masih bisa membaca `~/.ssh`), tetapi tanpa jaringan tidak bisa mengirimnya ke mana pun. Overhead sekitar 4 sampai 5 milidetik per perintah (diukur di Linux).

## Hooks (eksperimental, mati secara bawaan)

Hook adalah program kecil milik Anda yang dijalankan di titik tertentu: sebelum alat dipakai, sesudahnya, saat asisten mau berhenti, dan seterusnya. Dengan hook Anda bisa memblokirr sesuatu atau menambah pemeriksaan.

**Nyalakan:** `EZK_FEATURES=+hooks`. Hook menjalankan program di komputer Anda, jadi tidak aktif sendiri.

**Hanya di folder dipercaya.** Hooks dari proyek (`.ezkielyna/settings.json`, `.claude/settings.json`, dan versi `.local`-nya) dibaca hanya jika folder dipercaya. Hooks milik Anda sendiri di `~/.config/ezkielyna/settings.json` atau `~/.claude/settings.json` selalu berlaku.

**Kompatibel dengan `.claude/settings.json`:** bagian `hooks` memakai format yang sama (nama kejadian, `matcher`, `type`, `command`). Hooks yang sudah Anda tulis di sana bisa dipakai apa adanya.

Kejadian yang ada: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `Notification`.

Cara kerja hook perintah: hook menerima JSON di stdin. **Keluar dengan kode 2 = blokir**, dan teks di stderr dikirim ke asisten sebagai alasan. Kode 0 = lanjut. Kode lain = tidak memblokirr, hanya ditampilkan. Batas waktu 60 detik.

### Contoh 1: larang mengubah `.env`

Buat file `.ezkielyna/hooks/jaga-env.sh`:
```sh
#!/bin/sh
# Menerima JSON tentang pemanggilan alat di stdin.
if grep -q '\.env' ; then
  echo "File .env tidak boleh diubah. Minta pengguna melakukannya." >&2
  exit 2
fi
exit 0
```
Lalu di `.ezkielyna/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "sh .ezkielyna/hooks/jaga-env.sh" }]
      }
    ]
  }
}
```
Hasilnya: setiap kali asisten mencoba mengedit atau menulis file dan JSON-nya menyebut `.env`, langkah itu diblokir dan asisten membaca alasannya. (Contoh ini sengaja kasar: ia juga memblokirr file yang namanya hanya mengandung ".env".)

### Contoh 2: jalankan test sebelum selesai

`.ezkielyna/hooks/tes-dulu.sh`:
```sh
#!/bin/sh
if ! out=$(bun test 2>&1); then
  echo "Test masih gagal. Perbaiki dulu:" >&2
  echo "$out" | tail -n 30 >&2
  exit 2
fi
exit 0
```
`.ezkielyna/settings.json`:
```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "sh .ezkielyna/hooks/tes-dulu.sh", "timeout": 120 }] }
    ]
  }
}
```
Jika test gagal, asisten tidak boleh berhenti dan diminta memperbaiki. Supaya tidak berputar selamanya, setelah **8** blokir berturut-turut hook `Stop` diabaikan. Batas waktu hook paling lama 60 detik walau Anda menulis angka lebih besar, jadi pakai test yang cepat.

Hal lain yang perlu diketahui:
- Hook `PreToolUse` yang menjawab "izinkan" melewati pertanyaan izin biasa, tetapi **tidak pernah** mengalahkan aturan tolak, mode Rencana, folder yang belum dipercaya, atau folder terlindungi.
- Hook juga bisa memakai `type: "http"` (mengirim JSON ke alamat yang Anda tulis).
- Saat sesi dimulai, aplikasi menampilkan daftar hooks yang aktif. Daftar muncul lagi hanya bila hooks berubah. Di folder yang belum dipercaya, aplikasi memberi tahu bahwa hooks proyek dilewati.
- Variabel lingkungan rahasia asisten dibuang dari proses hook.
