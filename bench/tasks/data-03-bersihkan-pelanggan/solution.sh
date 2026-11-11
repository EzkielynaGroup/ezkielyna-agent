python3 - <<'EOF'
import csv
from datetime import datetime

def iso(value):
    value = value.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d %b %Y"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError(value)

best = {}
with open("customers.csv", newline="") as f:
    for row in csv.DictReader(f):
        email = row["email"].strip().lower()
        item = (" ".join(row["name"].split()).title(), email, iso(row["signup_date"]))
        if email not in best or item[2] < best[email][2]:
            best[email] = item
with open("customers_clean.csv", "w", newline="") as f:
    out = csv.writer(f)
    out.writerow(["name", "email", "signup_date"])
    out.writerows(sorted(best.values(), key=lambda item: (item[2], item[1])))
EOF
