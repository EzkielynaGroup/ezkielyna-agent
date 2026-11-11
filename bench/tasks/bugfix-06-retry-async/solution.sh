python3 - <<'PY'
from pathlib import Path

p = Path('src/retry.ts')
s = p.read_text()
old = '      return fn()'
new = '      return await fn()'
assert s.count(old) == 1, 'expected one return from the async retry loop'
p.write_text(s.replace(old, new))
PY
