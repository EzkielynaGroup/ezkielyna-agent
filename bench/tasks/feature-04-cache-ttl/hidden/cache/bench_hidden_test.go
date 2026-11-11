package cache

import (
	"testing"
	"time"
)

func TestExpiry(t *testing.T) {
	now := time.Unix(1000, 0)
	c := New[string, int](100*time.Millisecond, func() time.Time { return now })
	c.Set("a", 1)
	c.SetTTL("b", 2, 500*time.Millisecond)
	now = now.Add(99 * time.Millisecond)
	if v, ok := c.Get("a"); !ok || v != 1 {
		t.Fatal("a should still be there")
	}
	now = now.Add(time.Millisecond)
	if _, ok := c.Get("a"); ok {
		t.Fatal("a should have expired")
	}
	if v, ok := c.Get("b"); !ok || v != 2 || c.Len() != 1 {
		t.Fatalf("b should remain, len %d", c.Len())
	}
	now = now.Add(400 * time.Millisecond)
	if c.Len() != 0 {
		t.Fatalf("len %d, want 0", c.Len())
	}
}
