python3 - <<'PY'
from pathlib import Path

p = Path('src/diskon.ts')
s = p.read_text()
old = 'return nominal - (nominal * persen) / 100'
new = 'return (nominal * persen) / 100'
assert s.count(old) == 1, 'expected exactly one discount calculation'
p.write_text(s.replace(old, new))
PY
