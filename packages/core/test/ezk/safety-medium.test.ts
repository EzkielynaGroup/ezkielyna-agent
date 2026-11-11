import { describe, expect, test } from "bun:test"
import { denyMatches, isReadOnly, splitCommand } from "../../src/ezk/safety/bash"
import { escalationAlways, evaluateRules, parseRule, riskyPrefix } from "../../src/ezk/safety/rules"

const denied = (rule: string, cmd: string) => {
  const rules = [parseRule(rule, "deny")!]
  return evaluateRules(rules, { permission: "bash", pattern: cmd })?.action === "deny"
}
const ro = (cmd: string, trusted = true) => isReadOnly(cmd, { trusted })

describe("M1 deny rules vs quoting and wrappers", () => {
  test("exact attack strings are denied", () => {
    for (const cmd of ["rm -rf x", "'rm' -rf x", "r''m -rf x", "\\rm -rf x", '"rm" -rf x', "if true; then rm -rf x; fi", "command rm x", "builtin rm x", "exec rm x", "timeout 5 command rm x"])
      expect(`${cmd}:${denied("Bash(rm *)", cmd)}`).toBe(`${cmd}:true`)
    for (const cmd of ["git push origin", 'git "push" origin', "git -C . push", "git -C /tmp/x -c a=b push origin", "git --no-pager push", "command git -C . push"])
      expect(`${cmd}:${denied("Bash(git push *)", cmd)}`).toBe(`${cmd}:true`)
  })
  test("unrelated commands stay unmatched", () => {
    expect(denied("Bash(rm *)", "echo rm")).toBe(false)
    expect(denied("Bash(git push *)", "git -C . status")).toBe(false)
    expect(denied("Bash(rm *)", "rmdir x")).toBe(false)
  })
  test("denyMatches on a raw segment", () => {
    const s = splitCommand("do 'rm' x")
    expect(s.ok && denyMatches("rm *", s.segments[0]!)).toBe(true)
  })
})

describe("M2 read-only list", () => {
  test("attack strings are not read-only", () => {
    for (const cmd of ["cat .en*", "cat {.env,x}", "cat .e''nv", "cat .ENV", "cat .Env.local", "git diff --no-index /dev/null ~/.ssh/id_rsa", "git diff /dev/null /etc/passwd", "git log -- ~/.ssh/id_rsa", "rg -fpats x", "cat $HOME/.ssh/id_rsa", "cat ~/x", "cat .ssh/id_rsa", "cat ID_RSA", "cat .git/config", "cat ../x", "cat /etc/passwd"])
      expect(`${cmd}:${ro(cmd)}`).toBe(`${cmd}:false`)
  })
  test("plain project reads still work", () => {
    for (const cmd of ["cat README.md", "cat .env.example", "head -n 5 src/a.ts", "ls src", "git status", "git diff HEAD~1", "git log -n 5", "git diff -- src/a.ts", "rg 'foo bar' src", "pwd"])
      expect(`${cmd}:${ro(cmd)}`).toBe(`${cmd}:true`)
    expect(ro("git status", false)).toBe(false)
  })
})

describe("M3 / M8 riskyPrefix", () => {
  test("multi-token prefixes are risky", () => {
    for (const p of ["sh -c *", "rm -rf *", "python3 -c *", "bash -lc *", "awk *", "sed *", "tar *", "git *", "bash *", "python *", "node -e *", "node *", "git -c core.pager=x *", "git checkout *", "pnpm dlx *", "bun x *", "docker run *", "cp *", "timeout 5 rm *", "'rm' -rf *", "r*", "/bin/sh -c *", "Bash *"])
      expect(`${p}:${riskyPrefix(p)}`).toBe(`${p}:true`)
  })
  test("ordinary prefixes are still saveable", () => {
    for (const p of ["bun test *", "git status *", "git diff *", "npm run build *", "python scripts/check.py *", "ls *", "cargo test *"])
      expect(`${p}:${riskyPrefix(p)}`).toBe(`${p}:false`)
  })
  test("escalation always list is empty for risky prefixes", () => {
    expect(escalationAlways("require_escalated", "bash")).toEqual([])
    expect(escalationAlways("require_escalated", "python")).toEqual([])
    expect(escalationAlways("with_network", "curl")).toEqual([])
    expect(escalationAlways("with_network", "git")).toEqual([])
    expect(escalationAlways("with_network", "git push")).toEqual([])
    expect(escalationAlways("with_network", "cargo build")).toEqual(["with_network:cargo build *"])
  })
})
