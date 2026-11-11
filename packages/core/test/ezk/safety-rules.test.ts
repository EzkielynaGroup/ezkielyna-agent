import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { evaluateRules, forgetRule, loadRules, parseRule, rememberRule, riskyPrefix } from "../../src/ezk/safety/rules"

const tmp: string[] = []
afterEach(() => {
  for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function dirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-rules-"))
  tmp.push(base)
  const root = path.join(base, "project")
  const userConfig = path.join(base, "config")
  const home = path.join(base, "home")
  for (const d of [root, userConfig, home]) fs.mkdirSync(d, { recursive: true })
  return { root, userConfig, home }
}
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

describe("parseRule", () => {
  test("Claude tool names map to ours", () => {
    expect(parseRule("Bash(bun test *)", "allow")).toMatchObject({ permission: "bash", specifier: "bun test *" })
    expect(parseRule("Edit(src/**)", "deny")).toMatchObject({ permission: "edit", specifier: "src/**" })
    expect(parseRule("Write", "ask")).toMatchObject({ permission: "edit", specifier: undefined })
    expect(parseRule("WebFetch(domain:example.com)", "allow")).toMatchObject({ permission: "webfetch" })
    expect(parseRule("Bash(*)", "allow")!.specifier).toBeUndefined()
    expect(parseRule("not a rule (", "allow")).toBeUndefined()
  })
})

describe("evaluateRules: deny > ask > allow, first match wins", () => {
  const rules = [
    parseRule("Bash(git *)", "allow")!,
    parseRule("Bash(git push *)", "ask")!,
    parseRule("Bash(git push --force *)", "deny")!,
    parseRule("Edit(**/*.lock)", "deny")!,
    parseRule("Edit(src/**)", "allow")!,
    parseRule("WebFetch(domain:*.example.com)", "allow")!,
  ]
  const hit = (permission: string, pattern: string) => evaluateRules(rules, { permission, pattern, root: "/p" })?.action
  test("a narrow allow cannot carve out of a broad deny, and ask beats allow", () => {
    expect(hit("bash", "git status")).toBe("allow")
    expect(hit("bash", "git push origin main")).toBe("ask")
    expect(hit("bash", "git push --force origin")).toBe("deny")
    expect(hit("bash", "npm test")).toBeUndefined()
  })
  test("compound commands: allow needs every piece, deny needs one", () => {
    expect(hit("bash", "git status && rm -rf ~")).toBeUndefined()
    expect(hit("bash", "git status; git push --force x")).toBe("deny")
  })
  test("paths use gitignore style globs", () => {
    expect(hit("edit", "src/a/b.ts")).toBe("allow")
    expect(hit("edit", "src/bun.lock")).toBe("deny")
    expect(hit("edit", "README.md")).toBeUndefined()
  })
  test("webfetch domains", () => {
    expect(hit("webfetch", "https://docs.example.com/x")).toBe("allow")
    expect(hit("webfetch", "https://example.com.evil.io/x")).toBeUndefined()
  })
})

describe("loading and saving", () => {
  test("project allow rules only count when the folder is trusted; deny/ask always do", () => {
    const d = dirs()
    write(path.join(d.root, ".ezkielyna", "settings.local.json"), { permissions: { allow: ["Bash(bun test *)"], deny: ["Bash(curl *)"] } })
    write(path.join(d.root, ".claude", "settings.json"), { permissions: { allow: ["Bash(make *)"], ask: ["Bash(git push *)"] } })
    write(path.join(d.userConfig, "settings.json"), { permissions: { allow: ["Bash(ls *)"] } })
    const trusted = loadRules({ ...d, trusted: true }).map((r) => `${r.action}:${r.raw}`)
    expect(trusted).toEqual(expect.arrayContaining(["allow:Bash(bun test *)", "deny:Bash(curl *)", "allow:Bash(make *)", "ask:Bash(git push *)", "allow:Bash(ls *)"]))
    const untrusted = loadRules({ ...d, trusted: false }).map((r) => `${r.action}:${r.raw}`)
    expect(untrusted).not.toContain("allow:Bash(bun test *)")
    expect(untrusted).not.toContain("allow:Bash(make *)")
    expect(untrusted).toEqual(expect.arrayContaining(["deny:Bash(curl *)", "ask:Bash(git push *)", "allow:Bash(ls *)"]))
  })

  test("rememberRule writes settings.local.json and git-ignores it; forgetRule removes it", () => {
    const d = dirs()
    const file = rememberRule(d.root, "Bash(bun test *)")
    rememberRule(d.root, "Bash(bun test *)")
    expect(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow).toEqual(["Bash(bun test *)"])
    expect(fs.readFileSync(path.join(d.root, ".ezkielyna", ".gitignore"), "utf8")).toContain("settings.local.json")
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(forgetRule(d.root, "Bash(bun test *)")).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow).toEqual([])
  })

  test("an existing .ezkielyna/.gitignore keeps its lines", () => {
    const d = dirs()
    fs.mkdirSync(path.join(d.root, ".ezkielyna"), { recursive: true })
    fs.writeFileSync(path.join(d.root, ".ezkielyna", ".gitignore"), "node_modules")
    rememberRule(d.root, "Bash(make *)")
    expect(fs.readFileSync(path.join(d.root, ".ezkielyna", ".gitignore"), "utf8")).toBe("node_modules\nsettings.local.json\n")
  })
})

describe("riskyPrefix", () => {
  test("destructive commands, interpreters and pushes are never remembered for the whole project", () => {
    for (const p of ["rm *", "sudo *", "curl *", "python *", "bash *", "npx *", "git push *", "git reset *", "*", ""]) expect(`${p}:${riskyPrefix(p)}`).toBe(`${p}:true`)
    for (const p of ["bun test *", "git status *", "npm run build *", "python scripts/check.py *"]) expect(`${p}:${riskyPrefix(p)}`).toBe(`${p}:false`)
  })
})
