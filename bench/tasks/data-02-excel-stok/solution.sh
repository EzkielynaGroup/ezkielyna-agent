python3 - <<'EOF'

def read_xlsx(path, sheet="Stok"):
    """Minimal .xlsx reader (stdlib only): returns the rows of one sheet as lists of strings."""
    import re
    import zipfile
    import xml.etree.ElementTree as ET

    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iter("{%s}t" % ns["m"])))
        book = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = None
        for s in book.find("m:sheets", ns):
            if s.get("name") == sheet:
                rid = s.get("{%s}id" % ns["r"])
                for rel in rels:
                    if rel.get("Id") == rid:
                        target = "xl/" + rel.get("Target").lstrip("/").removeprefix("xl/")
        root = ET.fromstring(z.read(target))
        rows = []
        for row in root.iter("{%s}row" % ns["m"]):
            cells = {}
            for c in row.findall("m:c", ns):
                col = re.match(r"[A-Z]+", c.get("r")).group(0)
                kind = c.get("t")
                if kind == "inlineStr":
                    value = "".join(t.text or "" for t in c.iter("{%s}t" % ns["m"]))
                elif kind == "s":
                    value = shared[int(c.find("m:v", ns).text)]
                else:
                    v = c.find("m:v", ns)
                    value = v.text if v is not None else ""
                cells[col] = value
            width = max((ord(k[-1]) - 64 for k in cells), default=0)
            rows.append([cells.get(chr(65 + i), "") for i in range(width)])
        return rows


import csv
rows = read_xlsx("data/inventory.xlsx")
items = [(r[0], r[1], int(float(r[2])), int(float(r[3]))) for r in rows[1:]]
low = sorted(((s, n, q, l - q) for s, n, q, l in items if q < l), key=lambda x: (-x[3], x[0]))
with open("low_stock.csv", "w", newline="") as f:
    out = csv.writer(f)
    out.writerow(["sku", "nama", "qty", "kekurangan"])
    out.writerows(low)
EOF
