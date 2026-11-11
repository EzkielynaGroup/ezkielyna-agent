// Lightweight project verify-command detection shared by the opt-in loop and
// hard mode. Keep it separate from session-start's subprocess/toolchain probes.
import fs from "node:fs"
import path from "node:path"

export function detectPackageManager(root: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { packageManager?: string }
    const named = pkg.packageManager?.split("@")[0]
    if (named) return named
  } catch {}
  const has = (f: string) => fs.existsSync(path.join(root, f))
  if (has("bun.lock") || has("bun.lockb")) return "bun"
  if (has("pnpm-lock.yaml")) return "pnpm"
  if (has("yarn.lock")) return "yarn"
  if (has("package-lock.json")) return "npm"
  if (has("package.json")) return "npm"
  if (has("uv.lock")) return "uv"
  if (has("poetry.lock")) return "poetry"
  if (has("Cargo.lock") || has("Cargo.toml")) return "cargo"
  return undefined
}

export interface VerifyStep {
  kind: "test" | "typecheck" | "lint"
  command: string
}

export interface Verify {
  source: "package.json" | "Makefile" | "pytest" | "cargo" | "go"
  steps: VerifyStep[]
  /** All steps joined with " && ", cheapest first (typecheck, lint, test). */
  command: string
}

const verifyCache = new Map<string, Verify | null>()

function runner(pm: string | undefined, script: string) {
  const name = pm ?? "npm"
  if (script === "test") return name === "yarn" ? "yarn test" : `${name} test`
  return name === "yarn" ? `yarn ${script}` : `${name} run ${script}`
}

function make(source: Verify["source"], steps: VerifyStep[]): Verify | undefined {
  if (!steps.length) return undefined
  const order = { typecheck: 0, lint: 1, test: 2 } as const
  const sorted = steps.toSorted((a, b) => order[a.kind] - order[b.kind])
  return { source, steps: sorted, command: sorted.map((s) => s.command).join(" && ") }
}

export function detectVerify(root: string): Verify | undefined {
  const cached = verifyCache.get(root)
  if (cached !== undefined) return cached ?? undefined
  const found = detectVerifyUncached(root)
  verifyCache.set(root, found ?? null)
  return found
}

export function resetVerifyCache() {
  verifyCache.clear()
}

function detectVerifyUncached(root: string): Verify | undefined {
  const exists = (f: string) => fs.existsSync(path.join(root, f))
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(root, f), "utf8")
    } catch {
      return ""
    }
  }
  if (exists("package.json")) {
    try {
      const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> }
      const scripts = pkg.scripts ?? {}
      const pm = detectPackageManager(root)
      const pick = (names: string[]) => names.find((n) => typeof scripts[n] === "string" && scripts[n]!.trim())
      const steps: VerifyStep[] = []
      const test = pick(["test", "test:unit"])
      // `echo "Error: no test specified" && exit 1` is the npm init placeholder, not a test
      if (test && !/no test specified/.test(scripts[test]!)) steps.push({ kind: "test", command: runner(pm, test) })
      const tc = pick(["typecheck", "type-check", "check-types", "tsc"])
      if (tc) steps.push({ kind: "typecheck", command: runner(pm, tc) })
      const lint = pick(["lint"])
      if (lint) steps.push({ kind: "lint", command: runner(pm, lint) })
      const v = make("package.json", steps)
      if (v) return v
    } catch {}
  }
  if (exists("Makefile")) {
    const mk = read("Makefile")
    const target = (n: string) => new RegExp(`^${n}\\s*:`, "m").test(mk)
    const steps: VerifyStep[] = []
    if (target("test")) steps.push({ kind: "test", command: "make test" })
    else if (target("check")) steps.push({ kind: "test", command: "make check" })
    if (target("lint")) steps.push({ kind: "lint", command: "make lint" })
    const v = make("Makefile", steps)
    if (v) return v
  }
  if (exists("Cargo.toml")) return make("cargo", [{ kind: "test", command: "cargo test" }])
  const hasPytest =
    exists("pytest.ini") ||
    exists("conftest.py") ||
    /\[tool\.pytest/.test(read("pyproject.toml")) ||
    /\[tool:pytest\]|\[pytest\]/.test(read("setup.cfg") + read("tox.ini"))
  if (hasPytest) return make("pytest", [{ kind: "test", command: "pytest -q" }])
  if (exists("go.mod")) return make("go", [{ kind: "test", command: "go test ./..." }])
  return undefined
}
