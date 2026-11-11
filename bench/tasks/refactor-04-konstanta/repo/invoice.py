from harga import harga_dengan_ppn
from ongkir import ongkir


def total_invoice(items, berat_kg):
    """items: list of (nama, harga). PPN 11% dari subtotal, ongkir ditambahkan setelah PPN."""
    subtotal = sum(harga for _, harga in items)
    ppn = round(subtotal * 0.11)
    return {"subtotal": subtotal, "ppn": ppn, "ongkir": ongkir(berat_kg), "total": subtotal + ppn + ongkir(berat_kg)}


def ringkas(items):
    return f"{len(items)} barang, PPN {0.11:.0%}, ongkir mulai {15000}"
