import { slugify } from "./slug"

export function postUrl(title: string, id: number) {
  return `/blog/${id}-${slugify(title)}`
}
