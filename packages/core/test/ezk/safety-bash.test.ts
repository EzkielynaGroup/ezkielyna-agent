import { describe, expect, test } from "bun:test"
import { allowMatches, bashPatternRegex, denyMatches, isReadOnly, splitCommand, unwrapLayers } from "../../src/ezk/safety/bash"

const segments = (cmd: string) => {
  const split = splitCommand(cmd)
  if (!split.ok) throw new Error(split.reason)
  return split.segments
}
const texts = (cmd: string) => segments(cmd).map((s) => s.text)
const allows = (rule: string, cmd: string) => {
  const split = splitCommand(cmd)
  return split.ok && split.segments.every((s) => allowMatches(rule, s))
}

describe("splitCommand", () => {
  test("splits on && || ; | & and newlines", () => {
    expect(texts("bun test && rm -rf ~")).toEqual(["bun test", "rm -rf ~"])
    expect(texts("bun test; rm -rf ~")).toEqual(["bun test", "rm -rf ~"])
    expect(texts("a || b | c & d\ne")).toEqual(["a", "b", "c", "d", "e"])
    expect(texts("a |& b")).toEqual(["a", "b"])
  })

  test("substitutions become their own segments and mark the outer one dynamic", () => {
    const s = segments("echo $(rm -rf ~) `curl x`")
    expect(s.map((x) => x.text)).toContain("rm -rf ~")
    expect(s.map((x) => x.text)).toContain("curl x")
    expect(s[0]!.dynamic).toBe(true)
    expect(segments('echo "$(whoami)"').map((x) => x.text)).toContain("whoami")
    expect(segments("cat <(curl evil)").map((x) => x.text)).toContain("curl evil")
  })

  test("quotes keep separators inside one word", () => {
    expect(texts("git commit -m 'a && b; c'")).toEqual(["git commit -m 'a && b; c'"])
    expect(texts('echo "x | y"')).toEqual(['echo "x | y"'])
  })

  test("subshells and groups split too", () => {
    expect(texts("(cd x && rm y)")).toEqual(["cd x", "rm y"])
    expect(texts("{ a; b; }")).toEqual(["a", "b"])
  })

  test("redirects: file writes are flagged, 2>&1 and /dev/null are not", () => {
    expect(segments("bun test > out.txt")[0]!.writes).toBe(true)
    expect(segments("bun test >> out.txt")[0]!.writes).toBe(true)
    expect(segments("bun test &> out.txt")[0]!.writes).toBe(true)
    expect(segments("bun test 2>&1")[0]!.writes).toBe(false)
    expect(segments("bun test 2>/dev/null")[0]!.writes).toBe(false)
    expect(segments("bun test >/dev/null 2>&1")[0]!.writes).toBe(false)
    expect(segments("bun test 2>&1 | tail -5").map((s) => s.text)).toEqual(["bun test", "tail -5"])
  })

  test("fails closed on input it cannot read", () => {
    expect(splitCommand("echo 'open").ok).toBe(false)
    expect(splitCommand('echo "open').ok).toBe(false)
    expect(splitCommand("cat <<EOF\nx\nEOF").ok).toBe(false)
    expect(splitCommand("echo $(rm").ok).toBe(false)
    expect(splitCommand("ls >").ok).toBe(false)
  })

  test("variables mark the segment dynamic", () => {
    expect(segments("bun test $FILE")[0]!.dynamic).toBe(true)
    expect(segments("bun test '$FILE'")[0]!.dynamic).toBe(false)
  })
})

describe("unwrapLayers", () => {
  test("env, timeout, nice, nohup, npx and bunx are peeled off", () => {
    expect(unwrapLayers("timeout 5 npx vitest run".split(" "))!.map((l) => l.join(" "))).toEqual(["timeout 5 npx vitest run", "npx vitest run", "vitest run"])
    expect(unwrapLayers("env FOO=1 bun test".split(" "))!.at(-1)).toEqual(["bun", "test"])
    expect(unwrapLayers("FOO=1 bun test".split(" "))!.at(-1)).toEqual(["bun", "test"])
    expect(unwrapLayers("nice -n 5 bun test".split(" "))!.at(-1)).toEqual(["bun", "test"])
    expect(unwrapLayers("bunx --bun tsc".split(" "))!.at(-1)).toEqual(["tsc"])
  })

  test("refuses to unwrap dangerous env assignments and unknown wrapper flags", () => {
    expect(unwrapLayers("LD_PRELOAD=/x.so bun test".split(" "))).toBeUndefined()
    expect(unwrapLayers("PATH=/tmp bun test".split(" "))).toBeUndefined()
    expect(unwrapLayers("env -S 'x' bun".split(" "))).toBeUndefined()
    expect(unwrapLayers("npx -p evil vitest".split(" "))).toBeUndefined()
    expect(unwrapLayers("timeout abc rm".split(" "))).toBeUndefined()
  })
})

describe("rule patterns", () => {
  test("trailing ' *' also matches no arguments; the space is significant", () => {
    expect(bashPatternRegex("git log *").test("git log")).toBe(true)
    expect(bashPatternRegex("git log *").test("git log -5")).toBe(true)
    expect(bashPatternRegex("ls *").test("lsof")).toBe(false)
    expect(bashPatternRegex("ls*").test("lsof")).toBe(true)
    expect(bashPatternRegex("bun test:*").test("bun test x")).toBe(true)
  })

  test("bun test * does not allow bun test; rm -rf ~ (or && / | / $())", () => {
    expect(allows("bun test *", "bun test")).toBe(true)
    expect(allows("bun test *", "bun test src/a.test.ts")).toBe(true)
    expect(allows("bun test *", "bun test; rm -rf ~")).toBe(false)
    expect(allows("bun test *", "bun test && rm -rf ~")).toBe(false)
    expect(allows("bun test *", "bun test | sh")).toBe(false)
    expect(allows("bun test *", "bun test $(rm -rf ~)")).toBe(false)
    expect(allows("bun test *", "bun test `rm -rf ~`")).toBe(false)
    expect(allows("bun test *", "bun test > ~/.bashrc")).toBe(false)
  })

  test("wrappers are unwrapped for allow rules, but a wrapper rule never approves what it wraps", () => {
    expect(allows("vitest *", "npx vitest run")).toBe(true)
    expect(allows("vitest *", "timeout 60 npx vitest run")).toBe(true)
    expect(allows("npx vitest *", "npx vitest run")).toBe(true)
    expect(allows("npx *", "npx vitest run")).toBe(false)
    expect(allows("timeout *", "timeout 5 rm -rf x")).toBe(false)
    expect(allows("env *", "env rm -rf x")).toBe(false)
    expect(allows("bun test *", "LD_PRELOAD=/x.so bun test")).toBe(false)
  })

  test("deny rules catch the wrapped command at any layer", () => {
    const seg = segments("timeout 5 rm -rf build")[0]!
    expect(denyMatches("rm *", seg)).toBe(true)
    expect(denyMatches("git push *", segments("env GIT=1 git push origin")[0]!)).toBe(true)
  })
})

describe("read-only list", () => {
  const trusted = { trusted: true }
  const untrusted = { trusted: false }
  test("keeps the original safe commands", () => {
    for (const cmd of ["ls", "ls -l", "ls -la", "ls -a", "pwd"]) expect(isReadOnly(cmd, untrusted)).toBe(true)
    for (const cmd of ["git status", "git status -s", "git diff", "git diff --stat", "git log", "git log --oneline"]) {
      expect(isReadOnly(cmd, trusted)).toBe(true)
      expect(isReadOnly(cmd, untrusted)).toBe(false)
    }
  })

  test("extends carefully: rg and cat/head/tail inside the project only", () => {
    expect(isReadOnly("rg -n TODO src", trusted)).toBe(true)
    expect(isReadOnly("cat src/a.ts", trusted)).toBe(true)
    expect(isReadOnly("head -n 20 README.md", trusted)).toBe(true)
    expect(isReadOnly("tail -50 log.txt", trusted)).toBe(true)
    expect(isReadOnly("ls -la | head -5", trusted)).toBe(true)
    expect(isReadOnly("cat /etc/passwd", trusted)).toBe(false)
    expect(isReadOnly("cat ~/.ssh/id_rsa", trusted)).toBe(false)
    expect(isReadOnly("cat ../secret", trusted)).toBe(false)
    expect(isReadOnly("cat .env", trusted)).toBe(false)
    expect(isReadOnly("cat config/.env.local", trusted)).toBe(false)
    expect(isReadOnly("tail -f log.txt", trusted)).toBe(false)
    expect(isReadOnly("rg --pre sh x", trusted)).toBe(false)
    expect(isReadOnly("rg -z x", trusted)).toBe(false)
    expect(isReadOnly("rg x /", trusted)).toBe(false)
    expect(isReadOnly("ls /", trusted)).toBe(false)
  })

  test("anything that writes, substitutes or chains to a non-read-only command is not read-only", () => {
    expect(isReadOnly("ls > files.txt", trusted)).toBe(false)
    expect(isReadOnly("cat $(echo a)", trusted)).toBe(false)
    expect(isReadOnly("ls && rm -rf x", trusted)).toBe(false)
    expect(isReadOnly("git diff --output=x", trusted)).toBe(false)
    expect(isReadOnly("git -c core.pager=sh log", trusted)).toBe(false)
    expect(isReadOnly("git push", trusted)).toBe(false)
    expect(isReadOnly("find . -exec rm {} ;", trusted)).toBe(false)
  })
})
