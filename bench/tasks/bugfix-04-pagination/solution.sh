python3 - <<'PY'
from pathlib import Path

p = Path('paginate/paginate.go')
s = p.read_text()
replacements = {
    'totalPages := len(items) / perPage': 'totalPages := (len(items) + perPage - 1) / perPage',
    'start := page * perPage': 'start := (page - 1) * perPage',
}
for old, new in replacements.items():
    assert s.count(old) == 1, f'expected exactly one occurrence of {old!r}'
    s = s.replace(old, new)
p.write_text(s)
PY
