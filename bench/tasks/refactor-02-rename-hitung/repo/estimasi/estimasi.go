package estimasi

import "example.com/toko/ongkir"

// Termurah mengembalikan ongkir paling murah ke semua tujuan.
func Termurah(beratGram int) int {
	murah := -1
	for _, t := range []ongkir.Tujuan{ongkir.Jawa, ongkir.Sumatra, ongkir.Kalimantan, ongkir.Lainnya} {
		if biaya := ongkir.Hitung(beratGram, t); murah < 0 || biaya < murah {
			murah = biaya
		}
	}
	return murah
}
