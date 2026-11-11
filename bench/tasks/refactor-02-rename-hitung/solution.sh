python3 - <<'PY'
from pathlib import Path
import re

files = list(Path('.').rglob('*.go'))
assert files, 'expected Go source files'
changed = 0
for p in files:
    s = p.read_text()
    updated, count = re.subn(r'\bHitung\b', 'HitungOngkir', s)
    if count:
        p.write_text(updated)
        changed += count
assert changed > 0, 'expected at least one Hitung reference'
PY
