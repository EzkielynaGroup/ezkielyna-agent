python3 - <<'EOF'
import csv
total = {}
with open("penjualan.csv", newline="") as f:
    for row in csv.DictReader(f):
        total[row["kota"]] = total.get(row["kota"], 0) + int(row["qty"]) * int(row["harga_satuan"])
with open("ringkasan.csv", "w", newline="") as f:
    out = csv.writer(f)
    out.writerow(["kota", "total_omzet"])
    for kota, omzet in sorted(total.items(), key=lambda item: -item[1]):
        out.writerow([kota, omzet])
EOF
