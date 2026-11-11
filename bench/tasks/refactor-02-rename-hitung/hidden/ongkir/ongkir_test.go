package ongkir

import "testing"

func TestHitungOngkir(t *testing.T) {
	if got := HitungOngkir(1500, Jawa); got != 18000 {
		t.Fatalf("got %d", got)
	}
	if got := HitungOngkir(200, Sumatra); got != 15000 {
		t.Fatalf("got %d", got)
	}
}
