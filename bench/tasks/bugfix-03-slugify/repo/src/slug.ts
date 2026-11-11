/** URL slug: lowercase ASCII letters and digits separated by single dashes. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/ /g, "-")
    .replace(/[^a-z0-9-]/g, "")
}
