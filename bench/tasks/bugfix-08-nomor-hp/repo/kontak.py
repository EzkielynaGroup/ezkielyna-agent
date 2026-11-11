from nomor import normalisasi


def gabung_duplikat(kontak):
    """kontak: list of (nama, nomor). Kontak dengan nomor yang sama setelah normalisasi digabung (nama pertama dipakai)."""
    hasil = {}
    for nama, nomor in kontak:
        hasil.setdefault(normalisasi(nomor), nama)
    return hasil
