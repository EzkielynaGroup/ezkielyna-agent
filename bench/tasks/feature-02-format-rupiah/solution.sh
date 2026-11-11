python3 - <<'PY'
from pathlib import Path

format_file = Path('src/format.ts')
s = format_file.read_text()
assert 'export function formatRupiah' not in s, 'formatRupiah already exists'
format_file.write_text(s + '''\nexport function formatRupiah(nilai: number): string {
  const bulat = Math.round(Math.abs(nilai))
  const angka = String(bulat).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ".")
  return `${nilai < 0 && bulat !== 0 ? "-" : ""}Rp ${angka}`
}
''')

p = Path('src/struk.ts')
s = p.read_text()
assert s.count('import { formatTanggal } from "./format"') == 1
s = s.replace('import { formatTanggal } from "./format"', 'import { formatRupiah, formatTanggal } from "./format"')
assert s.count('${item.nama}: Rp${item.harga}') == 1
assert s.count('TOTAL: Rp${total}') == 1
s = s.replace('${item.nama}: Rp${item.harga}', '${item.nama}: ${formatRupiah(item.harga)}')
s = s.replace('TOTAL: Rp${total}', 'TOTAL: ${formatRupiah(total)}')
p.write_text(s)
PY
cat > src/rupiah.test.ts <<'EOF'
import { expect, test } from "bun:test"
import { formatRupiah } from "./format"

test("formatRupiah", () => {
  expect(formatRupiah(1250000)).toBe("Rp 1.250.000")
  expect(formatRupiah(-5000)).toBe("-Rp 5.000")
})
EOF
