import pathlib
import re
import sys

bad = [str(p) for p in pathlib.Path(".").rglob("*.go") if not p.name.endswith("_test.go") and re.search(r"\bHitung\b", p.read_text())]
if bad:
    sys.exit("nama lama Hitung masih dipakai di: " + ", ".join(bad))
print("structure ok")
