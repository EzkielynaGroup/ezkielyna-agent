import { afterEach, describe, expect, test } from "bun:test"
import { symlinkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dir, "..")
const fake = join(root, "test", "fake-bin")
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function run(env: Record<string, string>, files: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "ezk-act-test-"))
  dirs.push(d)
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v)
  const out = join(d, "gh-output"), sum = join(d, "gh-summary"), dryOut = join(d, "dry-out"), args = join(d, "args")
  for (const f of [out, sum, dryOut, args]) writeFileSync(f, "")
  const r = spawnSync("node", [join(root, "scripts", "run.mjs")], {
    cwd: d, encoding: "utf8",
    env: {
      PATH: `${fake}:${process.env.PATH}`, HOME: d, EZK_ACTION_DRY_RUN: "1", GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, EZK_ACTION_DRY_OUT: dryOut,
      FAKE_EZK_ARGS_FILE: args, GITHUB_REPOSITORY: "o/r", ...env,
    },
  })
  const outputs = Object.fromEntries([...readFileSync(out, "utf8").matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)].map((m) => [m[1], m[3]]))
  return { r, outputs, summary: readFileSync(sum, "utf8"), dry: readFileSync(dryOut, "utf8"), dir: d, args: readFileSync(args, "utf8") }
}

function evilRepo() {
  const base = mkdtempSync(join(tmpdir(), "ezk-evil-")); dirs.push(base)
  const d = join(base, "repo"); mkdirSync(d)
  const g = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" })
  g("init", "-q", "-b", "main")
  writeFileSync(join(d, "a.txt"), "a"); writeFileSync(join(d, "ezkielyna.jsonc"), '{"safe":true}')
  g("add", "."); g("commit", "-qm", "base")
  g("checkout", "-qb", "feature/x")
  writeFileSync(join(d, "ezkielyna.jsonc"), '{"evil":"https://attacker.example"}')
  writeFileSync(join(d, "opencode.jsonc"), '{"evil":1}')
  writeFileSync(join(d, ".mcp.json"), '{"evil":1}')
  mkdirSync(join(d, ".ezkielyna", "plugins"), { recursive: true }); writeFileSync(join(d, ".ezkielyna", "plugins", "evil.js"), "x")
  g("add", "-A"); g("commit", "-qm", "branch")
  const ci = join(base, "ci.log"); writeFileSync(ci, "FAIL")
  writeFileSync(join(base, "args"), "")
  return { d, ci }
}
const fixEnv = (d: string, ci: string) => ({
  PATH: `${fake}:${process.env.PATH}`, HOME: d, EZK_ACTION_DRY_RUN: "1", GITHUB_REPOSITORY: "o/r", EZK_INPUT_MODE: "fix-ci", EZK_INPUT_LOG_FILE: ci,
  FAKE_EZK_ARGS_FILE: join(d, "..", "args"), GITHUB_HEAD_REF: "feature/x", GITHUB_RUN_ID: "7", EZK_DEFAULT_REF: "main",
})

describe("dry run with a fake ezkielyna", () => {
  test("custom mode: outputs, summary, no key needed", () => {
    const x = run({ EZK_INPUT_MODE: "custom", EZK_INPUT_PROMPT: "hi", EZK_INPUT_MAX_BUDGET: "0.5" })
    expect(x.r.status).toBe(0)
    expect(x.outputs).toMatchObject({ result: "All done.", turns: "1", "exit-code": "0", "cost-usd": "0.0123" })
    expect(x.summary).toContain("| Turns | 1 |")
    expect(x.summary).toContain("$0.0123")
  })
  test("review mode builds ONE comment from the diff", () => {
    const x = run({ EZK_INPUT_MODE: "review", EZK_PR_NUMBER: "5", FAKE_EZK_MODE: "review", EZK_ACTION_DIFF_FILE: "diff.patch" }, { "diff.patch": "+hello\n" })
    expect(x.r.status).toBe(0)
    const lines = x.dry.trim().split("\n")
    expect(lines.length).toBe(1)
    const a = JSON.parse(lines[0].replace("DRYRUN ", ""))
    expect(a).toMatchObject({ action: "comment", pr: 5 })
    expect(a.body).toContain("<!-- ezkielyna-agent-review -->")
    expect(a.body).toContain("Null deref")
  })
  test("only fix-ci marks the checkout trusted for the CLI (exec denies edits in untrusted folders); review stays untrusted", () => {
    const review = run({ EZK_INPUT_MODE: "review", EZK_PR_NUMBER: "5", FAKE_EZK_MODE: "review", EZK_ACTION_DIFF_FILE: "diff.patch" }, { "diff.patch": "+hello\n" })
    expect(review.args).toContain("trust=\n")
    const custom = run({ EZK_INPUT_MODE: "custom", EZK_INPUT_PROMPT: "hi", EZK_INPUT_MAX_BUDGET: "0.5" })
    expect(custom.args).toContain("trust=\n")
    const { d, ci } = evilRepo()
    const x = spawnSync("node", [join(root, "scripts", "run.mjs")], { cwd: d, encoding: "utf8", env: fixEnv(d, ci) })
    expect(x.status).toBe(0)
    expect(readFileSync(join(d, "..", "args"), "utf8")).toContain("trust=1")
  })
  test("fix-ci resets the failing branch's project config to the default branch before exec, and never commits it", () => {
    const { d, ci } = evilRepo()
    const x = spawnSync("node", [join(root, "scripts", "run.mjs")], { cwd: d, encoding: "utf8", env: { ...fixEnv(d, ci), FAKE_EZK_EDIT: "fixed.txt" } })
    expect(x.status).toBe(0)
    const seen = readFileSync(join(d, "..", "args"), "utf8")
    expect(seen).toContain('cfg={"safe":true}') // default branch version of ezkielyna.jsonc; opencode.jsonc and .mcp.json were deleted
    expect(seen).not.toContain("evil")
    expect(seen).toContain("plug=\n") // .ezkielyna/plugins removed
    expect(existsSync(join(d, ".ezkielyna", "plugins", "evil.js"))).toBe(false)
    expect(existsSync(join(d, ".mcp.json"))).toBe(false)
    expect(readFileSync(join(d, "ezkielyna.jsonc"), "utf8")).toBe('{"safe":true}')
    const a = JSON.parse(x.stdout.split("\n").find((l) => l.startsWith("DRYRUN "))!.replace("DRYRUN ", ""))
    expect(a.files).toEqual(["fixed.txt"]) // restored config shows as modified but is not part of the fix
  })
  test("fix-ci removes SYMLINKED .ezkielyna/.opencode/.claude/.mcp.json and leaves the link targets alone", () => {
    const { d, ci } = evilRepo()
    const g = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" })
    rmSync(join(d, ".ezkielyna"), { recursive: true, force: true }); rmSync(join(d, ".mcp.json"))
    mkdirSync(join(d, "evil", "plugins"), { recursive: true }); writeFileSync(join(d, "evil", "ezkielyna.json"), '{"evil":1}'); writeFileSync(join(d, "evil", "plugins", "evil.js"), "x")
    symlinkSync("evil", join(d, ".ezkielyna")); symlinkSync("evil", join(d, ".opencode")); symlinkSync("evil", join(d, ".claude")); symlinkSync("evil/ezkielyna.json", join(d, ".mcp.json"), "file")
    g("add", "-A"); g("commit", "-qm", "symlinks")
    expect(g("ls-files").stdout).toContain(".ezkielyna\n")
    const x = spawnSync("node", [join(root, "scripts", "run.mjs")], { cwd: d, encoding: "utf8", env: { ...fixEnv(d, ci), FAKE_EZK_EDIT: "fixed.txt" } })
    expect(x.status).toBe(0)
    for (const n of [".ezkielyna", ".opencode", ".claude", ".mcp.json"]) expect(() => lstatSync(join(d, n))).toThrow()
    expect(readFileSync(join(d, "evil", "plugins", "evil.js"), "utf8")).toBe("x") // the link was removed, not followed
    expect(readFileSync(join(d, "..", "args"), "utf8")).not.toContain("evil")
  })
  test("fix-ci does not commit config edits made by the agent either", () => {
    const { d, ci } = evilRepo()
    const x = spawnSync("node", [join(root, "scripts", "run.mjs")], { cwd: d, encoding: "utf8", env: { ...fixEnv(d, ci), FAKE_EZK_EDIT: ".ezkielyna/plugins/new.js" } })
    expect(x.stdout).toContain("no code change proposed")
  })
  test("trust-project: true keeps the branch config (explicit opt-in)", () => {
    const { d, ci } = evilRepo()
    spawnSync("node", [join(root, "scripts", "run.mjs")], { cwd: d, encoding: "utf8", env: { ...fixEnv(d, ci), EZK_INPUT_TRUST_PROJECT: "true" } })
    expect(readFileSync(join(d, "..", "args"), "utf8")).toContain("evil")
  })
  test("fix-ci fails closed when the default branch cannot be read", () => {
    const { d, ci } = evilRepo()
    const x = spawnSync("node", [join(root, "scripts", "run.mjs")], { cwd: d, encoding: "utf8", env: { ...fixEnv(d, ci), EZK_DEFAULT_REF: "no-such-ref" } })
    expect(x.status).toBe(1)
    expect(x.stdout).toContain("::error")
    expect(readFileSync(join(d, "..", "args"), "utf8")).toBe("")
  })
  test("review with an empty diff does nothing", () => {
    const x = run({ EZK_INPUT_MODE: "review", EZK_PR_NUMBER: "5", EZK_ACTION_DIFF_FILE: "diff.patch" }, { "diff.patch": "\n" })
    expect(x.r.status).toBe(0)
    expect(x.dry).toBe("")
  })
  test("fix-ci proposes a branch under ezkielyna/, never the head or default branch", () => {
    const d = mkdtempSync(join(tmpdir(), "ezk-repo-")); dirs.push(d)
    const g = (...a: string[]) => spawnSync("git", a, { cwd: d, encoding: "utf8" })
    g("init", "-q"); writeFileSync(join(d, "a.txt"), "a"); g("add", "."); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i")
    const logDir = mkdtempSync(join(tmpdir(), "ezk-log-")); dirs.push(logDir)
    writeFileSync(join(logDir, "ci.log"), "FAIL test x")
    const env = { EZK_INPUT_MODE: "fix-ci", EZK_INPUT_LOG_FILE: join(logDir, "ci.log"), FAKE_EZK_EDIT: "fixed.txt", GITHUB_HEAD_REF: "feature/x", GITHUB_RUN_ID: "42", EZK_DEFAULT_REF: "HEAD" }
    const x = spawnSync("node", [join(root, "scripts", "run.mjs")], {
      cwd: d, encoding: "utf8", env: { PATH: `${fake}:${process.env.PATH}`, HOME: d, EZK_ACTION_DRY_RUN: "1", GITHUB_REPOSITORY: "o/r", ...env },
    })
    expect(x.status).toBe(0)
    const a = JSON.parse(x.stdout.split("\n").find((l) => l.startsWith("DRYRUN "))!.replace("DRYRUN ", ""))
    expect(a.action).toBe("fix-pr")
    expect(a.branch).toMatch(/^ezkielyna\/fix-ci-42-1-/)
    expect(a.base).toBe("feature/x")
    expect(a.files).toEqual(["fixed.txt"])
    expect(g("branch", "--show-current").stdout.trim()).not.toBe(a.branch) // dry run does not switch branches
  })
  test("fix-ci never commits workflow files", () => {
    const d = mkdtempSync(join(tmpdir(), "ezk-repo-")); dirs.push(d)
    const logDir = mkdtempSync(join(tmpdir(), "ezk-log-")); dirs.push(logDir)
    spawnSync("git", ["init", "-q"], { cwd: d })
    writeFileSync(join(logDir, "ci.log"), "x")
    const x = spawnSync("node", [join(root, "scripts", "run.mjs")], {
      cwd: d, encoding: "utf8",
      env: { PATH: `${fake}:${process.env.PATH}`, HOME: d, EZK_ACTION_DRY_RUN: "1", GITHUB_REPOSITORY: "o/r", EZK_INPUT_MODE: "fix-ci", EZK_INPUT_LOG_FILE: join(logDir, "ci.log"), FAKE_EZK_EDIT: ".github/workflows/x.yml", EZK_INPUT_TRUST_PROJECT: "true" },
    })
    expect(x.status).toBe(0)
    expect(x.stdout).not.toContain("DRYRUN")
    expect(x.stdout).toContain("no code change proposed")
  })
  test("exit 1 fails the step and prints an error; budget stop only warns", () => {
    const bad = run({ EZK_INPUT_MODE: "custom", EZK_INPUT_PROMPT: "x", FAKE_EZK_MODE: "fail" })
    expect(bad.r.status).toBe(1)
    expect(bad.r.stdout).toContain("::error")
    expect(bad.outputs["exit-code"]).toBe("1")
    const budget = run({ EZK_INPUT_MODE: "custom", EZK_INPUT_PROMPT: "x", FAKE_EZK_MODE: "budget" })
    expect(budget.r.status).toBe(0)
    expect(budget.r.stdout).toContain("::warning")
    expect(budget.outputs["exit-code"]).toBe("2")
  })
  test("bad inputs fail before running anything", () => {
    const x = run({ EZK_INPUT_MODE: "custom", EZK_INPUT_PROMPT: "x", EZK_INPUT_MAX_BUDGET: "-3" })
    expect(x.r.status).toBe(1)
    expect(x.r.stdout).toContain("max-budget")
    expect(x.args).toBe("")
  })
  test("the key reaches the CLI only as EZKIELYNA_API_KEY and is never printed", () => {
    const key = "ezk-SECRETKEY-123456"
    const x = run({ EZK_ACTION_DRY_RUN: "1", EZK_INPUT_API_KEY: key, EZK_INPUT_MODE: "custom", EZK_INPUT_PROMPT: "x", FAKE_EZK_MODE: "fail" })
    expect(x.args).toContain(`key_len=${key.length}`)
    expect(x.r.stdout + x.r.stderr + x.summary + JSON.stringify(x.outputs)).not.toContain(key)
  })
})

describe("static checks", () => {
  test("action.yml: key masked, no workflows dir in this repo's action, linux only, outputs", () => {
    const y = readFileSync(join(root, "action.yml"), "utf8")
    expect(y).toContain("::add-mask::")
    expect(y).toContain("Linux runners only")
    for (const o of ["result:", "cost-usd:", "turns:", "exit-code:"]) expect(y).toContain(o)
    expect(y).toContain("required: true")
    expect(y).not.toMatch(/ezk-[A-Za-z0-9]{12,}/)
  })
  test("examples pin versions and use minimal permissions", () => {
    for (const f of ["review-on-PR.yml", "fix-ci.yml"]) {
      const p = join(root, "examples", f)
      expect(existsSync(p)).toBe(true)
      const y = readFileSync(p, "utf8")
      expect(y).toContain("permissions:")
      expect(y).not.toMatch(/permissions:\s*write-all/)
      expect(y).not.toMatch(/uses: [^\n]+@(main|master|latest)\b/)
      expect(y).toContain("secrets.EZKIELYNA_API_KEY")
    }
  })
  test("fix-ci example and README use persist-credentials: false; action has trust-project defaulting to false", () => {
    expect(readFileSync(join(root, "examples", "fix-ci.yml"), "utf8")).toContain("persist-credentials: false")
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("persist-credentials: false")
    expect(readFileSync(join(root, "action.yml"), "utf8")).toMatch(/trust-project:[\s\S]*?default: "false"/)
    expect(readFileSync(join(root, "scripts", "run.mjs"), "utf8")).not.toMatch(/EZK_TRUST_PROJECT: *"1"/)
  })
  test("no supplier names in user-visible files", () => {
    const bad = /(openai|anthropic|claude|codex|minimax|deepseek|opencode)/i
    for (const f of ["action.yml", "README.md", "examples/review-on-PR.yml", "examples/fix-ci.yml"]) {
      expect(readFileSync(join(root, f), "utf8")).not.toMatch(bad)
    }
  })
})
