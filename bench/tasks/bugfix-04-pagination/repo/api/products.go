package api

import (
	"strconv"

	"example.com/shop/paginate"
)

func ListProducts(all []string, pageParam string) paginate.Page[string] {
	page, err := strconv.Atoi(pageParam)
	if err != nil || page < 1 {
		page = 1
	}
	return paginate.Paginate(all, page, 4)
}
