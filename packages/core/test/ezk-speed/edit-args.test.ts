import { describe, expect, test } from "bun:test"
import { normalizeEditArgs, pathCandidates, recoverOldString, resolveEditPath } from "../../src/ezk/speed/edit-args"

describe("normalizeEditArgs", () => {
  test("snake_case and synonyms map to canonical keys", () => {
    const r = normalizeEditArgs({ file_path: "a.ts", old_string: "x", new_string: "y", replace_all: "true" })
    expect(r.args).toEqual({ filePath: "a.ts", oldString: "x", newString: "y", replaceAll: true })
    expect(r.fixes.length).toBe(5)
  })
  test("canonical keys win over aliases", () => {
    const r = normalizeEditArgs({ filePath: "a", path: "b", oldString: "1", old_string: "2", newString: "3" })
    expect(r.args).toEqual({ filePath: "a", oldString: "1", newString: "3" })
  })
  test("clean input is untouched", () => {
    const input = { filePath: "/a", oldString: "x", newString: "y", replaceAll: false }
    const r = normalizeEditArgs(input)
    expect(r.args).toEqual(input)
    expect(r.fixes).toEqual([])
  })
  test("non-objects pass through", () => {
    const untouched: unknown = normalizeEditArgs("x").args
    expect(untouched).toBe("x")
  })
})

const fsOf = (files: string[]) => ({ cwd: "/proj", exists: (p: string) => files.includes(p), isAbsolute: (p: string) => p.startsWith("/") })

describe("resolveEditPath", () => {
  test("existing literal path is never changed", () => {
    expect(resolveEditPath("src/a.ts", fsOf(["/proj/src/a.ts"]))).toEqual({ path: "/proj/src/a.ts", fixed: false })
    expect(resolveEditPath("/proj/src/a.ts", fsOf(["/proj/src/a.ts"]))).toEqual({ path: "/proj/src/a.ts", fixed: false })
  })
  test("project-relative path written with a leading slash", () => {
    expect(resolveEditPath("/src/a.ts", fsOf(["/proj/src/a.ts"]))).toEqual({ path: "/proj/src/a.ts", fixed: true })
  })
  test("quotes, ./, file://, @, :line, git a/ prefix", () => {
    const f = fsOf(["/proj/src/a.ts"])
    for (const raw of ['"src/a.ts"', "`src/a.ts`", "./src/a.ts", "file:///proj/src/a.ts", "@src/a.ts", "src/a.ts:42", "a/src/a.ts", "src\\a.ts", " src/a.ts "]) {
      expect(resolveEditPath(raw, f)).toEqual({ path: "/proj/src/a.ts", fixed: true })
    }
  })
  test("home expansion", () => {
    const r = resolveEditPath("~/x.ts", { ...fsOf(["/home/u/x.ts"]), home: "/home/u" })
    expect(r).toEqual({ path: "/home/u/x.ts", fixed: true })
  })
  test("ambiguous: two different existing candidates -> unchanged", () => {
    // "a/src/a.ts" could be the git prefix form (-> src/a.ts) or a real dir a/src/a.ts
    const r = resolveEditPath("a/src/a.ts", fsOf(["/proj/src/a.ts", "/proj/a/src/a.ts"]))
    expect(r).toEqual({ path: "/proj/a/src/a.ts", fixed: false }) // literal exists, wins
    const r2 = resolveEditPath("/src/a.ts", fsOf(["/src/a.ts_other"]))
    expect(r2.fixed).toBe(false)
  })
  test("nothing exists -> literal resolution, so the tool reports not found", () => {
    expect(resolveEditPath("nope.ts", fsOf([]))).toEqual({ path: "/proj/nope.ts", fixed: false })
  })
  test("never escapes by guessing: candidates are only cleaned forms of the input", () => {
    expect(pathCandidates("../../etc/passwd", "/proj").every((c) => c.includes("etc/passwd"))).toBe(true)
  })
})

describe("recoverOldString", () => {
  const file = "const title = “Hello”;\nfunction f() {\n  return 1\n}\n"
  test("smart quotes typed as straight quotes", () => {
    const r = recoverOldString(file, 'const title = "Hello";', 'const title = "Bye";')
    expect(r?.via).toBe("typographic")
    expect(r?.span).toBe("const title = “Hello”;")
  })
  test("line numbers copied from read output", () => {
    const r = recoverOldString(file, "2→function f() {\n3→  return 1\n4→}", "2→function f() {\n3→  return 2\n4→}")
    expect(r?.via).toBe("line-numbers")
    expect(r?.span).toBe("function f() {\n  return 1\n}")
    expect(r?.newString).toBe("function f() {\n  return 2\n}")
  })
  test("code fence around the snippet", () => {
    const r = recoverOldString("a = 1\nb = 2\n", "```py\na = 1\nb = 2\n```", "```py\na = 1\nb = 3\n```")
    expect(r?.span).toBe("a = 1\nb = 2")
    expect(r?.newString).toBe("a = 1\nb = 3")
  })
  test("html entities when the file has none", () => {
    const r = recoverOldString("if (a < b && c) {}", "if (a &lt; b &amp;&amp; c) {}", "if (a &lt; b) {}")
    expect(r?.span).toBe("if (a < b && c) {}")
    expect(r?.newString).toBe("if (a < b) {}")
  })
  test("CRLF file with LF snippet after line-number strip", () => {
    const r = recoverOldString("x\r\ny\r\n", "1→x\n2→y", "1→x\n2→z")
    expect(r?.span).toBe("x\r\ny")
    expect(r?.newString).toBe("x\r\nz")
  })
  test("ambiguous (two matches) -> undefined unless replaceAll", () => {
    const f = "“a”\n“a”\n"
    expect(recoverOldString(f, '"a"', '"b"')).toBeUndefined()
    expect(recoverOldString(f, '"a"', '"b"', true)?.span).toBe("“a”")
  })
  test("no match -> undefined", () => {
    expect(recoverOldString(file, "does not exist", "x")).toBeUndefined()
  })
  test("only some lines numbered is not stripped", () => {
    expect(recoverOldString("a\nb\n", "1→a\nb", "x")).toBeUndefined()
  })
})
