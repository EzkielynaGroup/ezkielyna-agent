package ongkir

import "testing"

func TestHitung(t *testing.T) {
	if got := Hitung(1500, Jawa); got != 18000 {
		t.Fatalf("got %d", got)
	}
	if got := Hitung(200, Sumatra); got != 15000 {
		t.Fatalf("got %d", got)
	}
}
