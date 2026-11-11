python3 - <<'PY'
from pathlib import Path

p = Path('src/dates.ts')
s = p.read_text()
old = 'return Math.floor((b - a) / DAY)'
new = 'return Math.round((b - a) / DAY) + 1'
assert s.count(old) == 1, 'expected exactly one date-range calculation'
p.write_text(s.replace(old, new))
PY
