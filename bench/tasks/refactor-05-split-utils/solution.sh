python3 - <<'PY'
from pathlib import Path

Path('src/strings.ts').write_text('''export function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}
''')
Path('src/math.ts').write_text('''export function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

export function average(values: number[]) {
  return values.length === 0 ? 0 : sum(values) / values.length
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
''')
Path('src/utils.ts').unlink()
imports = {
    'src/report.ts': ('import { average, capitalize, sum } from "./utils"', 'import { capitalize } from "./strings"\nimport { average, sum } from "./math"'),
    'src/profile.ts': ('import { clamp, truncate } from "./utils"', 'import { truncate } from "./strings"\nimport { clamp } from "./math"'),
    'src/utils.test.ts': ('import { average, capitalize, clamp, sum, truncate } from "./utils"', 'import { capitalize, truncate } from "./strings"\nimport { average, clamp, sum } from "./math"'),
}
for name, (old, new) in imports.items():
    p = Path(name)
    s = p.read_text()
    assert s.count(old) == 1, f'{name} is missing its original utils import'
    p.write_text(s.replace(old, new))
PY
