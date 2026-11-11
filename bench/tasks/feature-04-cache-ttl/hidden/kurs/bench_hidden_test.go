package kurs

import "testing"

func TestCached(t *testing.T) {
	calls := 0
	kurs := Buat(func(string) float64 { calls++; return 16000 })
	kurs("USD")
	kurs("USD")
	if calls != 1 {
		t.Fatalf("calls %d", calls)
	}
}
