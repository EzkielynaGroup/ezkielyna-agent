package ongkir

type Tujuan string

const (
	Jawa       Tujuan = "jawa"
	Sumatra    Tujuan = "sumatra"
	Kalimantan Tujuan = "kalimantan"
	Lainnya    Tujuan = "lainnya"
)

var tarif = map[Tujuan]int{Jawa: 9000, Sumatra: 15000, Kalimantan: 18000, Lainnya: 25000}

// Hitung mengembalikan ongkos kirim: tarif per kg tujuan, berat dibulatkan ke atas, minimal 1 kg.
func Hitung(beratGram int, tujuan Tujuan) int {
	kg := (beratGram + 999) / 1000
	if kg < 1 {
		kg = 1
	}
	return kg * tarif[tujuan]
}
