import csv
import sys

expected = [
    ["name", "email", "signup_date"],
    ["Siti Aminah", "siti@example.com", "2026-01-02"],
    ["Budi Santoso", "budi@example.com", "2026-01-03"],
    ["Rahmat Hidayat", "rahmat@mail.id", "2026-02-01"],
    ["Dewi Lestari", "dewi@mail.id", "2026-02-07"],
    ["Ahmad", "ahmad@mail.id", "2026-02-15"],
    ["Eko Prasetyo", "eko@mail.id", "2026-03-01"],
]
try:
    with open("customers_clean.csv", newline="") as f:
        got = [[cell.strip() for cell in row] for row in csv.reader(f) if row]
except FileNotFoundError:
    sys.exit("customers_clean.csv not found")
if got != expected:
    sys.exit("expected:\n" + "\n".join(map(str, expected)) + "\ngot:\n" + "\n".join(map(str, got)))
print("customers_clean ok")
