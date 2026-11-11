cat > src/validation.ts <<'EOF'
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
EOF
python3 - <<'PY'
from pathlib import Path

old = r'!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test({value})'
for name, values in [('user.ts', ['email']), ('newsletter.ts', ['email']), ('invite.ts', ['from', 'to'])]:
    p = Path('src') / name
    s = p.read_text()
    for value in values:
        needle = old.format(value=value)
        assert s.count(needle) == 1, f'{name} must contain one validator for {value}'
        s = s.replace(needle, f'!isValidEmail({value})')
    p.write_text('import { isValidEmail } from "./validation"\n' + s)
PY
