cat > nomor.py <<'EOF'
import re


def normalisasi(nomor: str) -> str:
    """Ubah nomor HP Indonesia ke format +62 tanpa spasi atau tanda baca.

    Contoh: '0812-3456-7890' -> '+6281234567890'. Nomor yang mengandung huruf ditolak (ValueError).
    """
    if re.search(r"[A-Za-z]", nomor):
        raise ValueError(f"nomor tidak valid: {nomor!r}")
    digit = re.sub(r"\D", "", nomor)
    if digit.startswith("0"):
        digit = "62" + digit[1:]
    if not digit.startswith("62"):
        raise ValueError(f"bukan nomor Indonesia: {nomor!r}")
    return "+" + digit
EOF
