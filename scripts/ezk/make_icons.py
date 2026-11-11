#!/usr/bin/env python3
"""Generate Ezkielyna Agent app icons (png/icns/ico) from brand/logo.png.
Usage: make_icons.py <logo.png> <out_dir>
Source is 640px, so large sizes are upscaled (Lanczos). Replace brand/logo.png with a bigger
master when one exists and re-run."""
import subprocess, sys, shutil, tempfile
from pathlib import Path
from PIL import Image

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
logo = Image.open(src).convert("RGBA")

def canvas(size, inset):
    """Logo (already a rounded square) on a transparent canvas, scaled to size*inset."""
    c = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    s = round(size * inset)
    l = logo.resize((s, s), Image.LANCZOS)
    c.paste(l, ((size - s) // 2, (size - s) // 2), l)
    return c

MAC = 824 / 1024  # Apple icon grid: artwork is ~80% of canvas
# plain pngs (linux hicolor + generic)
for n in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
    canvas(n, 1.0).save(out / f"{n}x{n}.png")
canvas(256, 1.0).save(out / "128x128@2x.png")
canvas(1024, 1.0).save(out / "icon.png")
# dock.png: used by unpackaged Electron on macOS (matches icns inset)
canvas(256, MAC).save(out / "dock.png")
# icns via iconutil
with tempfile.TemporaryDirectory() as t:
    iset = Path(t) / "icon.iconset"
    iset.mkdir()
    for base in (16, 32, 128, 256, 512):
        canvas(base, MAC).save(iset / f"icon_{base}x{base}.png")
        canvas(base * 2, MAC).save(iset / f"icon_{base}x{base}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iset), "-o", str(out / "icon.icns")], check=True)
# ico (multi-size, no inset: Windows uses full-bleed)
canvas(256, 1.0).save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icons written to", out)
