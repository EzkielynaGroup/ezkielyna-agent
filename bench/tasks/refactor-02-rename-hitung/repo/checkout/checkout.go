package checkout

import "example.com/toko/ongkir"

func Total(subtotal, beratGram int, tujuan ongkir.Tujuan) int {
	return subtotal + ongkir.Hitung(beratGram, tujuan)
}
