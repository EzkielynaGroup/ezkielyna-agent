# Alur kerja: mundur, rencana, latar belakang, dan otomasi

Bagian 1 sampai 5 **(eksperimental, mati secara bawaan)**; bagian 6 dan 7 aktif. Tanda **(segera)** berarti belum ada di versi ini.

> **Catatan versi ini.** Bagian 1 sampai 4 (eksperimental, mati secara bawaan) sudah ada di kode tetapi dipasang dengan saklar dan belum menyala sendiri:
> ```
> EZK_FEATURES="+rewind,+planApproval,+handoff,+subagents"
> ```
> Bagian 5 (tugas latar belakang) dinyalakan dengan `EZK_FEATURES=+exec` (eksperimental, mati secara bawaan). Bagian 6 dan 7 aktif tanpa saklar.

## 1. Titik simpan (checkpoint) dan `/rewind` (eksperimental, mati secara bawaan: `+rewind`)

Setiap kali Anda mengirim pesan, aplikasi sudah menyimpan keadaan file proyek tepat sebelum asisten mulai bekerja. Itu **titik simpan** (checkpoint). Tidak ada salinan tambahan: aplikasi memakai snapshot yang memang sudah dibuat, dan snapshot lama dibersihkan sendiri setelah 7 hari. 100 checkpoint terbaru ditawarkan.

Buka dengan `/rewind` atau tekan **Esc** dua kali saat sesi sedang diam (di desktop: tombol **Rewind** di tiap pesan). Pilih pesan, lalu pilih apa yang dikembalikan:

| Pilihan | Yang terjadi |
|---|---|
| **File saja** | File yang diubah asisten sesudah titik simpan dikembalikan (atau dihapus bila belum ada). Obrolan tetap. Bisa dibatalkan ("Batalkan pemulihan file terakhir"). |
| **Obrolan saja** | Giliran sesudah titik itu disembunyikan. File tidak disentuh. `/redo` mengembalikannya. |
| **Keduanya** | File dan obrolan. `/redo` memulihkan keduanya. |
| **Ringkas mulai dari sini** | Giliran sesudah titik itu diganti satu pesan ringkasan (maksimal sekitar 250 kata). **Tidak bisa dibatalkan**, jadi aplikasi bertanya sekali lagi. Jika pembuatan ringkasan gagal, tidak ada yang berubah. |

Contoh: asisten mengubah lima file dan hasilnya salah. Buka `/rewind`, pilih pesan Anda sebelum itu, pilih **File saja**. Lima file kembali ke keadaan semula.

Penting: file yang **Anda** ubah sendiri sesudah titik simpan tidak ditimpa. Aplikasi melewatinya dan menampilkan peringatan berisi daftarnya.

## 2. Persetujuan rencana (eksperimental, mati secara bawaan: `+planApproval`)

Di mode **Rencana**, asisten hanya membaca dan menyusun rencana. Setelah rencana selesai, muncul kartu dengan empat pilihan:

- **Setujui & jalankan (Edit otomatis)**: rencana disimpan, daftar tugas dibuat dari langkah bernomor, lalu asisten mulai bekerja. Perubahan file di dalam proyek jalan tanpa bertanya; perintah dan web tetap bertanya.
- **Setujui & tanya tiap langkah**: sama, tetapi setiap perubahan bertanya.
- **Lanjut merencanakan**: kembali berdiskusi.
- **Edit rencana**: ubah teks rencana dulu.

Rencana disimpan di folder data aplikasi, **bukan di proyek Anda**. Jika obrolan nanti diringkas (ringkasan konteks), rencana yang sudah disetujui disisipkan lagi supaya tidak hilang. Di folder yang belum dipercaya, "Edit otomatis" tidak berlaku dan tetap bertanya.

## 3. `/handoff` (eksperimental, mati secara bawaan: `+handoff`)

Sesi panjang jadi berat. Ketik `/handoff <tujuan berikutnya>`, misalnya `/handoff lanjutkan ke halaman pembayaran`. Aplikasi membuat sesi **baru** dan mengisi kotak pesannya dengan prompt awal (dibuat model cepat dari ringkasan sesi lama) plus daftar file penting (maksimal 15, sebagai `@file`). Anda bisa mengedit sebelum mengirim. Jika model gagal membuatnya, sesi baru tetap dibuka dengan tujuan dan daftar file.

## 4. Subagen Explore (eksperimental, mati secara bawaan: `+subagents`)

Untuk pencarian di proyek besar, asisten bisa memanggil pembantu bernama **Explore**: ia hanya membaca, bekerja paling banyak 4 giliran, memakai model cepat termurah di kunci Anda, dan menjawab dengan baris `path:awal-akhir keterangan`. Hasilnya dipotong sekitar 2.000 token.

- Pembantu baru tersedia setelah asisten membaca/mencari 3 kali atau lebih dalam satu pesan, atau bila Anda menulis `@explore`. Pesan pendek tidak berubah sama sekali.
- Paling banyak 3 pembantu berjalan bersamaan, dan pembantu tidak memanggil pembantu lain.
- Pembantu buatan sendiri: file `.md` di `.ezkielyna/agents/` atau `.claude/agents/` (dari proyek hanya jika folder dipercaya). Secara bawaan hanya-baca.

## 5. Berjalan di latar belakang (eksperimental, mati secara bawaan: `+exec`)

Selama ini perintah dihentikan setelah 2 menit. Dengan fitur ini, perintah yang lama (server pengembangan, build panjang) terus berjalan dan asisten bisa memeriksanya lagi.

- Perintah yang belum selesai sesudah sekitar 10 detik mengembalikan nomor sesi dan tetap berjalan.
- Asisten bisa mengetik ke perintah itu, melihat daftar, atau menghentikannya. Mengetik meminta izin yang sama dengan perintah awalnya.
- Keluaran yang baru dikirim ke asisten pada giliran berikutnya.
- Batas: 16 proses sekaligus, 1 MiB keluaran per proses, dan proses yang 30 menit tidak disentuh dihentikan. Saat sesi dihapus atau aplikasi ditutup, semua proses beserta turunannya dihentikan.
- Dengan `+sandbox`, perintah latar belakang juga berjalan di sandbox seperti perintah biasa.
- Terminal punya `/tasks`; desktop punya baris **Tugas latar** di sidebar, keduanya dengan tombol Stop.

## 6. `ezkielyna exec`: untuk skrip dan CI

`ezkielyna exec` menjalankan satu tugas tanpa layar obrolan lalu berhenti. Cocok untuk skrip dan CI.

```
ezkielyna exec "perbaiki test yang gagal di src/cart.test.ts"
echo "jelaskan repo ini dalam 5 baris" | ezkielyna exec -
```

Tanpa `--json`, kemajuan keluar di stderr dan hanya jawaban akhir di stdout.

| Opsi | Fungsi |
|---|---|
| `--json` | Satu kejadian JSON per baris: `thread.started`, `turn.started`, `turn.completed` (dengan pemakaian token), `turn.failed`, `item.*`, `error`. |
| `--output-schema file` | Jawaban akhir harus berupa JSON yang cocok dengan skema itu. Jika tidak cocok, asisten diminta memperbaiki sekali; jika masih salah, kode keluar 1. |
| `-o file` | Tulis jawaban akhir ke file. |
| `--max-turns n` | Berhenti setelah n giliran model (kode 2). |
| `--max-budget usd` | Berhenti saat perkiraan biaya mencapai angka itu (kode 2). |
| `--permission-mode` | Karena tidak ada yang bisa ditanya: `ask` (bawaan, menolak), `acceptEdits`, `plan`, `safeAuto`, `full` (hanya di mesin sekali pakai). Nama dan artinya sama dengan di aplikasi (`auto` berarti `safeAuto`). Di **folder yang belum dipercaya** (`ezkielyna trust`) semua permintaan ditolak apa pun modenya, dan perubahan ke **folder terlindungi** (`.git`, `.ezkielyna`, `ezkielyna.json`, `.github/workflows`, dan sejenisnya) serta perintah yang menyebutnya selalu ditolak, juga di `full`. |
| `--resume id` | Lanjutkan sesi lama (`thread_id` dari `thread.started`). |
| `--cwd folder` | Folder kerja. |

Kode keluar: **0** selesai, **1** galat, **2** dihentikan batas giliran/biaya, **3** selesai tetapi ada tindakan yang ditolak oleh mode izin.

### Contoh CI (GitHub Actions)

Simpan kunci sebagai secret repositori bernama `EZKIELYNA_API_KEY`. **Jangan** menulis kunci di file workflow.

```yaml
name: ezkielyna review
on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - name: Pasang Ezkielyna Agent
        run: |
          curl -fsSL https://ezkielyna.store/agent/install.sh | sh
          echo "$HOME/.ezkielyna/bin" >> "$GITHUB_PATH"
      - name: Periksa perubahan
        env:
          EZKIELYNA_API_KEY: ${{ secrets.EZKIELYNA_API_KEY }}
        run: |
          ezkielyna exec --json --permission-mode plan --max-turns 30 --max-budget 0.50 \
            -o hasil.txt \
            "Tinjau perubahan di pull request ini terhadap main. Sebutkan hanya bug nyata." > events.jsonl
          cat hasil.txt
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ezkielyna-events
          path: events.jsonl
```

Tips: mulai dengan `plan` (hanya baca); selalu isi `--max-budget` di CI; `jq -c 'select(.type=="item.completed")' events.jsonl` menampilkan hanya langkah yang selesai. Action GitHub siap pakai untuk meninjau PR atau memperbaiki CI ada di folder `github-action/` repositori kami; penerbitannya ke Marketplace belum ada (segera).

## 7. `ezkielyna doctor`, `/context`, `/usage`

**`ezkielyna doctor`** memeriksa pemasangan Anda dan mencetak satu baris per pemeriksaan: versi, kunci API (hanya "ada" dan dari mana, **tidak pernah isinya**), koneksi dan kecepatannya, daftar model, file pengaturan, status folder dipercaya, ruang disk, dan saluran pembaruan. Tambahkan `--json` untuk mesin. Kode keluar 1 hanya bila ada pemeriksaan yang gagal. Contoh:
```
✓ Kunci API          ada (dari variabel lingkungan EZKIELYNA_API_KEY)
✓ Koneksi            terhubung (2 ms)
! Folder ini         belum dipercaya (/home/saya/proyek): instruksi dan hooks proyek diabaikan. Jalankan `ezkielyna trust` jika Anda yang membuatnya.
```
`✓` berarti baik, `!` berarti peringatan (tidak menggagalkan), `✗` berarti gagal.

**`/context`** (terminal) menampilkan isi permintaan terakhir ke model: prompt sistem, alat, instruksi proyek, memori, dan pesan, masing-masing dalam token dan persen dari jendela model. Angka dipecah dengan perkiraan lalu disesuaikan dengan hitungan asli dari gateway.

**`/usage`** menampilkan jumlah giliran, token masuk/keluar, perkiraan biaya, dan **cache**: persentase yang dibaca dari cache serta alasan cache meleset (permintaan pertama, model tidak melaporkan cache, ganti model, diam lebih dari 5 menit, baru dipadatkan, atau prompt sistem berubah). Dengan `+statusline` (eksperimental, mati secara bawaan), garis status di bawah terminal menunjukkan mis. `ctx 12% · $0.0001 · cache 0%`.
