python3 - <<'PY'
from pathlib import Path
from shutil import move

Path('Foto').mkdir(exist_ok=True)
Path('Dokumen').mkdir(exist_ok=True)
for item in Path('.').iterdir():
    if not item.is_file():
        continue
    target = {'jpg': 'Foto', 'jpeg': 'Foto', 'png': 'Foto', 'pdf': 'Dokumen', 'docx': 'Dokumen'}.get(item.suffix.lower().lstrip('.'))
    if target:
        folder = Path(target)
        folder.mkdir(exist_ok=True)
        move(str(item), str(folder / item.name))
PY
