package api

import "testing"

func TestListProducts(t *testing.T) {
	all := []string{"a", "b", "c", "d", "e"}
	if got := ListProducts(all, ""); len(got.Items) != 4 || got.Items[0] != "a" {
		t.Fatalf("default page = %v", got.Items)
	}
	if got := ListProducts(all, "2"); got.HasNext || len(got.Items) != 1 {
		t.Fatalf("page 2 = %+v", got)
	}
}
