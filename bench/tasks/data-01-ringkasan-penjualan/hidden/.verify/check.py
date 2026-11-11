import csv
import sys

expected = {}
with open(".verify/penjualan_asli.csv", newline="") as f:
    for row in csv.DictReader(f):
        expected[row["kota"]] = expected.get(row["kota"], 0) + int(row["qty"]) * int(row["harga_satuan"])
expected_rows = sorted(expected.items(), key=lambda item: -item[1])

try:
    with open("ringkasan.csv", newline="") as f:
        got = list(csv.reader(f))
except FileNotFoundError:
    sys.exit("ringkasan.csv not found")
if [h.strip().lower() for h in got[0]] != ["kota", "total_omzet"]:
    sys.exit(f"bad header: {got[0]}")
rows = [(r[0].strip(), float(r[1])) for r in got[1:] if r]
if [(k, float(v)) for k, v in expected_rows] != rows:
    sys.exit(f"expected {expected_rows}, got {rows}")
print("ringkasan ok")
