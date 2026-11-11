python3 - <<'EOF'
import re
src = open("csvlite.py").read()
src = src.replace('    return [field.strip() for field in line.split(",")]', """    import csv

    return [field.strip() for field in next(csv.reader([line]))]""")
open("csvlite.py", "w").write(src)
EOF
