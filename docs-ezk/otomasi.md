# Otomatisasi: `ezkielyna exec`

`ezkielyna exec` menjalankan satu tugas tanpa layar obrolan, lalu berhenti. Pakai di skrip dan CI (misalnya GitHub Actions). `ezkielyna run` tetap bisa dipakai seperti biasa; `exec` adalah yang format keluarannya stabil.

```bash
ezkielyna exec "perbaiki tes yang gagal di src/cart.test.ts"
echo "jelaskan repo ini dalam 5 baris" | ezkielyna exec -
```

Tanpa `--json`, kemajuan (perintah, file yang berubah) ditulis ke stderr dan hanya jawaban akhir ke stdout, jadi `jawaban=$(ezkielyna exec "...")` bisa dipakai.

## Opsi

| Opsi | Fungsinya |
|---|---|
| `--json` | Satu event JSON per baris di stdout, formatnya JSON yang kompatibel dengan alat otomasi lain: `thread.started`, `turn.started`, `turn.completed` (dengan jumlah token), `turn.failed`, `item.started` / `item.updated` / `item.completed` dan `error`. Jenis item: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`. Alat pembaca JSONL biasa bisa membacanya. |
| `--output-schema <file>` | File JSON Schema. Jawaban akhir harus berupa JSON yang cocok. Kalau tidak cocok, asisten diminta memperbaikinya satu kali; kalau masih salah, kode keluarnya 1. |
| `-o`, `--output-last-message <file>` | Menulis jawaban akhir ke file. |
| `--max-turns <n>` | Berhenti setelah `n` giliran model (kode keluar 2). |
| `--max-budget <usd>` | Berhenti saat perkiraan biaya run ini mencapai jumlah ini dalam dolar AS (kode keluar 2). Perkiraannya memakai daftar harga yang sama dengan Auto (Pintar). |
| `--permission-mode <mode>` | Yang terjadi saat sebuah alat butuh izin (di sini tidak ada orang yang bisa ditanya): `tanya-dulu` (bawaan: ditolak), `edit-otomatis` (perubahan file di dalam proyek boleh, perintah ditolak), `rencana` (hanya membaca), `otomatis-aman` (sama dengan `edit-otomatis` di sini), `penuh` (semua boleh; hanya untuk mesin CI sekali pakai). Nama Inggrisnya juga bisa: `ask`, `acceptEdits`, `plan`, `safeAuto`, `full`. Di **folder yang belum dipercaya** (`ezkielyna trust`) semua permintaan ditolak apa pun modenya, dan perubahan ke **folder terlindungi** (`.git`, `.ezkielyna`, `ezkielyna.json`, `.github/workflows`, dan sejenisnya) ditolak juga di `penuh`. |
| `--resume <id>` | Melanjutkan sesi sebelumnya. Id-nya adalah `thread_id` dari `thread.started`. |
| `--cwd <folder>` (juga `--cd`, `-C`) | Folder proyek yang dikerjakan. Tanpa opsi ini, dipakai folder kerja proses saat ini. |
| `-m provider/model`, `--agent`, `--variant` | Sama seperti `ezkielyna run`. |

## Kode keluar

| Kode | Arti |
|---|---|
| 0 | Selesai. |
| 1 | Galat (galat gateway, sesi tidak ada, atau jawaban tidak cocok dengan `--output-schema`). |
| 2 | Dihentikan oleh `--max-turns` atau `--max-budget`. |
| 3 | Selesai, tetapi ada tindakan yang ditolak oleh `--permission-mode`. |

## Catatan perilaku dan keamanan

- **Mode `penuh`** menyetujui (hanya sekali per permintaan) semua yang bukan perubahan ke folder terlindungi, termasuk akses ke folder di luar proyek (`external_directory`) dan permintaan keluar dari sandbox (`sandbox_escalation`). Karena itu `penuh` hanya berlaku di folder yang sudah dipercaya, dan Action GitHub tidak mengizinkannya. Pakai hanya di mesin CI sekali pakai.
- **Waktu habis perintah (fitur `exec` terpadu, belum aktif secara bawaan).** Perintah di latar depan hanya dihentikan oleh waktu habis jika Anda mengisi `timeout` secara eksplisit. Waktu habis bawaan tidak dipakai untuk perintah latar depan; perintah yang melewati batas tunggu berlanjut sebagai tugas latar belakang yang bisa dibaca dengan `write_stdin` dan dihentikan dengan `exec_stop`.
- **`fix-ci` di Action GitHub** mengembalikan konfigurasi proyek cabang yang gagal (`ezkielyna.json*`, `.ezkielyna/`, `.mcp.json`, dan nama konfigurasi lama) ke versi cabang utama sebelum agen berjalan, dan tidak pernah memasukkannya ke draft pull request. Masukan `trust-project: true` mematikan ini; jangan dipakai kecuali semua cabang Anda sudah ditinjau. Pakai `persist-credentials: false` pada `actions/checkout`.

## Contoh GitHub Actions

Simpan kunci Anda sebagai secret repositori bernama `EZKIELYNA_API_KEY` (Settings → Secrets and variables → Actions). Jangan pernah menulis kunci di file workflow.

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
          cat > schema.json <<'EOF'
          { "type": "object",
            "properties": { "ok": { "type": "boolean" }, "problems": { "type": "array", "items": { "type": "string" } } },
            "required": ["ok", "problems"] }
          EOF
          ezkielyna exec --json --permission-mode rencana --max-turns 30 --max-budget 0.50 \
            --output-schema schema.json -o result.json \
            "Tinjau perubahan di pull request ini terhadap main. Sebutkan bug nyata saja." > events.jsonl
          cat result.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ezkielyna-events
          path: events.jsonl
```

Tips:
- Mulai dengan `--permission-mode rencana` (hanya membaca). Pakai `edit-otomatis` hanya kalau job memang harus mengubah file, dan `penuh` hanya di runner sekali pakai.
- Selalu pasang `--max-budget` di CI.
- `jq -c 'select(.type=="item.completed")' events.jsonl` hanya menampilkan langkah yang sudah selesai.

## Pakai di GitHub Actions

Action siap pakai tersedia di folder `github-action/` repositori kami (penerbitan ke Marketplace belum ada; nama `ezkielyna/agent-action@v1.0.0` di bawah masih contoh) yang memasang Ezkielyna Agent dengan installer bertanda tangan dan menjalankan `ezkielyna exec --json`. Hanya untuk runner Linux (`ubuntu-latest`).

- `mode: review`: memeriksa diff pull request dan memasang **satu** komentar yang diperbarui setiap push. Izin: `contents: read`, `pull-requests: write`.
- `mode: fix-ci`: membaca log job yang gagal dan membuka **draft pull request** di cabang baru `ezkielyna/fix-ci-…`. Tidak pernah mendorong ke cabang pull request atau cabang utama. Izin: `contents: write`, `pull-requests: write`, `actions: read`.

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: ezkielyna/agent-action@v1.0.0
  with:
    api-key: ${{ secrets.EZKIELYNA_API_KEY }}
    mode: review
    max-budget: "0.50"
```

Simpan kunci sebagai secret `EZKIELYNA_API_KEY`; kunci disamarkan di log. Output: `result`, `cost-usd`, `turns`, `exit-code`. Contoh lengkap ada di `github-action/examples/`.
