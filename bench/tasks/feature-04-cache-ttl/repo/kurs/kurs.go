package kurs

import "example.com/kurs/cache"

// Buat membungkus fungsi pengambil kurs dengan cache.
func Buat(ambil func(kode string) float64) func(kode string) float64 {
	c := cache.New[string, float64]()
	return func(kode string) float64 {
		if nilai, ok := c.Get(kode); ok {
			return nilai
		}
		nilai := ambil(kode)
		c.Set(kode, nilai)
		return nilai
	}
}
