python3 - <<'EOF'
names = sorted({" ".join(line.split()).title() for line in open("tamu.txt", encoding="utf-8") if line.strip()})
open("daftar_tamu.txt", "w", encoding="utf-8").write("".join(f"{i}. {name}\n" for i, name in enumerate(names, 1)))
EOF
