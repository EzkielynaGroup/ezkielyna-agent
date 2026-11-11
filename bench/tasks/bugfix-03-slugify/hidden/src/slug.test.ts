import { expect, test } from "bun:test"
import { slugify } from "./slug"

test("collapses whitespace and punctuation", () => {
  expect(slugify("  Halo   Dunia!  ")).toBe("halo-dunia")
  expect(slugify("Tips & Trik: 2026")).toBe("tips-trik-2026")
})

test("transliterates accents instead of dropping letters", () => {
  expect(slugify("Café Ünïcode")).toBe("cafe-unicode")
})

test("no leading, trailing or double dashes", () => {
  expect(slugify("--a--b--")).toBe("a-b")
})

test("post urls", async () => {
  const { postUrl } = await import("./posts")
  expect(postUrl("Résumé Terbaik  2026", 7)).toBe("/blog/7-resume-terbaik-2026")
})
