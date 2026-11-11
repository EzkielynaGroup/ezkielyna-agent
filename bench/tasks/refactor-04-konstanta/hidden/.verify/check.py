"""Hidden structural check: PPN and ONGKIR_DASAR live only in constants.py."""
import pathlib
import re
import sys

problems = []
consts = pathlib.Path("constants.py")
text = consts.read_text() if consts.exists() else ""
if not re.search(r"^PPN\s*=\s*0\.11\s*$", text, re.M):
    problems.append("constants.py must define PPN = 0.11")
if not re.search(r"^ONGKIR_DASAR\s*=\s*15_?000\s*$", text, re.M):
    problems.append("constants.py must define ONGKIR_DASAR = 15000")
for path in pathlib.Path(".").glob("*.py"):
    if path.name == "constants.py":
        continue
    src = path.read_text()
    if re.search(r"\b0\.11\b|\b15_?000\b", src):
        problems.append(f"{path} still contains the magic number 0.11 or 15000")
for name in ("harga.py", "ongkir.py", "invoice.py"):
    if "constants" not in pathlib.Path(name).read_text():
        problems.append(f"{name} does not use constants")
if problems:
    print("\n".join(problems))
    sys.exit(1)
print("structure ok")
