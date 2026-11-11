package paginate

import (
	"reflect"
	"testing"
)

func items(n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = i
	}
	return out
}

func TestFirstPage(t *testing.T) {
	got := Paginate(items(10), 1, 4)
	if !reflect.DeepEqual(got.Items, []int{0, 1, 2, 3}) {
		t.Fatalf("page 1 = %v, want [0 1 2 3]", got.Items)
	}
}

func TestLastPartialPage(t *testing.T) {
	got := Paginate(items(10), 3, 4)
	if !reflect.DeepEqual(got.Items, []int{8, 9}) || got.TotalPages != 3 || got.HasNext {
		t.Fatalf("page 3 = %+v, want items [8 9], 3 pages, no next", got)
	}
}
