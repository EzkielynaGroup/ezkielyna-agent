package paginate

// Page is one page of results. Page numbers are 1-based; a page past the end has no items.
type Page[T any] struct {
	Items      []T
	Page       int
	TotalPages int
	HasNext    bool
}

func Paginate[T any](items []T, page, perPage int) Page[T] {
	totalPages := len(items) / perPage
	start := page * perPage
	end := start + perPage
	if start > len(items) {
		start = len(items)
	}
	if end > len(items) {
		end = len(items)
	}
	return Page[T]{Items: items[start:end], Page: page, TotalPages: totalPages, HasNext: page < totalPages}
}
