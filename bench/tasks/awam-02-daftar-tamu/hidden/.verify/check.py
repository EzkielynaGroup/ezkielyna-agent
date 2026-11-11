import sys

expected = ["1. Ahmad", "2. Budi Santoso", "3. Dewi Lestari", "4. Rina Marlina", "5. Siti Aminah"]
try:
    got = [line.strip() for line in open("daftar_tamu.txt", encoding="utf-8") if line.strip()]
except FileNotFoundError:
    sys.exit("daftar_tamu.txt tidak ada")
if got != expected:
    sys.exit(f"harusnya {expected}, ternyata {got}")
print("daftar tamu ok")
