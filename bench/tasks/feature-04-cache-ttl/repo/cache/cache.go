package cache

type Cache[K comparable, V any] struct {
	entries map[K]V
}

func New[K comparable, V any]() *Cache[K, V] {
	return &Cache[K, V]{entries: map[K]V{}}
}

func (c *Cache[K, V]) Get(key K) (V, bool) {
	value, ok := c.entries[key]
	return value, ok
}

func (c *Cache[K, V]) Set(key K, value V) {
	c.entries[key] = value
}

func (c *Cache[K, V]) Len() int {
	return len(c.entries)
}
