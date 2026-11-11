cat > cache/cache.go <<'EOF'
package cache

import "time"

type entry[V any] struct {
	value   V
	expires time.Time
}

type Cache[K comparable, V any] struct {
	entries map[K]entry[V]
	ttl     time.Duration
	now     func() time.Time
}

func New[K comparable, V any](ttl time.Duration, now func() time.Time) *Cache[K, V] {
	if now == nil {
		now = time.Now
	}
	return &Cache[K, V]{entries: map[K]entry[V]{}, ttl: ttl, now: now}
}

func (c *Cache[K, V]) Get(key K) (V, bool) {
	e, ok := c.entries[key]
	if !ok || !c.now().Before(e.expires) {
		delete(c.entries, key)
		var zero V
		return zero, false
	}
	return e.value, true
}

func (c *Cache[K, V]) Set(key K, value V) {
	c.SetTTL(key, value, c.ttl)
}

func (c *Cache[K, V]) SetTTL(key K, value V, ttl time.Duration) {
	c.entries[key] = entry[V]{value: value, expires: c.now().Add(ttl)}
}

func (c *Cache[K, V]) Len() int {
	n := 0
	for _, e := range c.entries {
		if c.now().Before(e.expires) {
			n++
		}
	}
	return n
}
EOF
python3 - <<'PY'
from pathlib import Path

p = Path('kurs/kurs.go')
s = p.read_text()
old_import = 'import "example.com/kurs/cache"'
new_import = 'import (\n\t"time"\n\n\t"example.com/kurs/cache"\n)'
old_new = 'cache.New[string, float64]()'
new_new = 'cache.New[string, float64](time.Minute, nil)'
assert s.count(old_import) == 1, 'expected the cache import'
assert s.count(old_new) == 1, 'expected the cache constructor'
p.write_text(s.replace(old_import, new_import).replace(old_new, new_new))
PY
cat > cache/cache_test.go <<'EOF'
package cache

import (
	"testing"
	"time"
)

func TestSetTTL(t *testing.T) {
	now := time.Unix(0, 0)
	c := New[string, string](time.Second, func() time.Time { return now })
	c.SetTTL("k", "v", 10*time.Millisecond)
	now = now.Add(10 * time.Millisecond)
	if _, ok := c.Get("k"); ok {
		t.Fatal("expired entry returned")
	}
}
EOF
