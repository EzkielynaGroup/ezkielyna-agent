def ongkir(berat_kg):
    if berat_kg <= 1:
        return 15000
    return 15000 + (berat_kg - 1) * 5000
