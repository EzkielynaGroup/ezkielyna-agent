python3 - <<'PY'
from pathlib import Path
import re

Path('constants.py').write_text('PPN = 0.11\nONGKIR_DASAR = 15000\n')
for name in ('harga.py', 'ongkir.py', 'invoice.py'):
    p = Path(name)
    s = p.read_text()
    s, ppn = re.subn(r'(?<![\w.])0\.11(?![\w.])', 'PPN', s)
    s, ongkir = re.subn(r'(?<!\w)15000(?!\w)', 'ONGKIR_DASAR', s)
    assert ppn + ongkir > 0, f'{name} contains no constants to extract'
    p.write_text('from constants import ONGKIR_DASAR, PPN\n' + s)
PY
