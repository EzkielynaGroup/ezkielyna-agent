package checkout

import (
	"testing"

	"example.com/toko/estimasi"
	"example.com/toko/ongkir"
)

func TestTotalDanEstimasi(t *testing.T) {
	if got := Total(100000, 2000, ongkir.Kalimantan); got != 136000 {
		t.Fatalf("total %d", got)
	}
	if got := estimasi.Termurah(3100); got != 36000 {
		t.Fatalf("termurah %d", got)
	}
}
