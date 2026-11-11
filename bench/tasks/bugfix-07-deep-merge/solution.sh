python3 - <<'PY'
from pathlib import Path

p = Path('src/merge.ts')
s = p.read_text()
replacements = {
    'typeof value === "object" && value !== null': 'typeof value === "object" && value !== null && !Array.isArray(value)',
    'const out = a': 'const out: Obj = { ...a }',
}
for old, new in replacements.items():
    assert s.count(old) == 1, f'expected exactly one occurrence of {old!r}'
    s = s.replace(old, new)
p.write_text(s)
PY
