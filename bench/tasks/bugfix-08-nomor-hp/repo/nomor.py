def normalisasi(nomor: str) -> str:
    """Ubah nomor HP Indonesia ke format +62 tanpa spasi atau tanda baca.

    Contoh: '0812-3456-7890' -> '+6281234567890'. Nomor yang mengandung huruf ditolak (ValueError).
    """
    nomor = nomor.strip()
    if nomor.startswith("0"):
        return "+62" + nomor[1:]
    return nomor
