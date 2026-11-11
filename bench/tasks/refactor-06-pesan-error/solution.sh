cat > src/pesan.ts <<'EOF'
export const PESAN = {
  akunTidakAda: "Akun tidak ditemukan",
  akunDiblokir: "Akun sedang diblokir, hubungi layanan pelanggan",
  jumlahTidakValid: "Jumlah transfer harus lebih dari nol",
  saldoKurang: "Saldo tidak cukup",
  pinTidakValid: "PIN harus 6 digit angka",
} as const
EOF
python3 - <<'PY'
from pathlib import Path

replacements = {
    'src/akun.ts': {
        '"Akun tidak ditemukan"': 'PESAN.akunTidakAda',
        '"Akun sedang diblokir, hubungi layanan pelanggan"': 'PESAN.akunDiblokir',
    },
    'src/transfer.ts': {
        '"Jumlah transfer harus lebih dari nol"': 'PESAN.jumlahTidakValid',
        '"Saldo tidak cukup"': 'PESAN.saldoKurang',
    },
    'src/pin.ts': {'"PIN harus 6 digit angka"': 'PESAN.pinTidakValid'},
}
for name, messages in replacements.items():
    p = Path(name)
    s = p.read_text()
    for old, new in messages.items():
        assert s.count(old) == 1, f'{name} must contain one {old}'
        s = s.replace(old, new)
    p.write_text('import { PESAN } from "./pesan"\n' + s)
PY
