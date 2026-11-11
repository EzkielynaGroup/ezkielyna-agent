import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runHardMode, sweepOrphanedHardRuns, type HardModeDependencies, type HardWorkspace } from "../../src/ezk/hard-mode"

const GIB = 1024 ** 3
const verify = { source: "package.json" as const, steps: [{ kind: "test" as const, command: "bun test" }], command: "bun test" }

function harness(input: {
  memory?: number
  outcomes?: Array<{ exitCode: number; costUSD: number; diff: string; verifyExit: number; limit?: "turns" | "budget" }>
} = {}) {
  const attempts = [1, 2, 3].map((attempt) => ({ attempt, directory: `/tmp/hard-${attempt}` }))
  const diffs = new Map((input.outcomes ?? []).map((outcome, i) => [i + 1, outcome.diff]))
  const workspaceEvents: string[] = []
  const gatewayCalls: { attempt: number; model: string; budgetUSD: number }[] = []
  let verifyCount = 0
  let active = 0
  let maxActive = 0
  let applied = ""
  const workspace: HardWorkspace = {
    attempts,
    async diff(attempt) {
      return diffs.get(attempt) ?? ""
    },
    async applicable(diff) {
      return { ok: true, paths: ["src/a.ts"] }
    },
    async apply(diff) {
      applied = diff
      workspaceEvents.push("apply")
    },
    async cleanup() {
      workspaceEvents.push("cleanup")
    },
  }
  const scripted = input.outcomes ?? []
  const deps: HardModeDependencies = {
    totalMemoryBytes: () => input.memory ?? 8 * GIB,
    prepare: async () => workspace,
    async runAttempt(args) {
      active++
      maxActive = Math.max(maxActive, active)
      gatewayCalls.push({ attempt: args.attempt, model: args.model, budgetUSD: args.budgetUSD })
      const result = scripted[args.attempt - 1] ?? { exitCode: 1, costUSD: 0, diff: "", verifyExit: 1 }
      await Promise.resolve() // keep concurrent runs observable to the sequential-rule assertion
      active--
      return { exitCode: result.exitCode, costUSD: result.costUSD, output: "mock Flash response", ...(result.limit ? { limit: result.limit } : {}) }
    },
    verifySandboxed: () => true,
    async verify() {
      const result = scripted[verifyCount++] ?? { exitCode: 1, costUSD: 0, diff: "", verifyExit: 1 }
      return { exitCode: result.verifyExit, output: "mock verify output" }
    },
  }
  return { deps, workspaceEvents, gatewayCalls, maxActive: () => maxActive, applied: () => applied }
}

describe("hard mode attempt orchestration", () => {
  test("first use removes only dead hard runs older than 24 hours", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-hard-sweep-test-"))
    const hardRoot = path.join(dataRoot, "ezk", "hard")
    const stale = path.join(hardRoot, "stale-run")
    const active = path.join(hardRoot, "active-run")
    const recent = path.join(hardRoot, "recent-run")
    const outside = path.join(dataRoot, "ezk", "other", "keep")
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    try {
      await fs.mkdir(stale, { recursive: true })
      await fs.writeFile(path.join(stale, ".owner.json"), JSON.stringify({ pid: 2_147_483_647 }))
      await fs.utimes(stale, old, old)
      await fs.mkdir(active, { recursive: true })
      await fs.writeFile(path.join(active, ".owner.json"), JSON.stringify({ pid: 42 }))
      await fs.utimes(active, old, old)
      await fs.mkdir(recent, { recursive: true })
      await fs.writeFile(path.join(recent, ".owner.json"), JSON.stringify({ pid: 43 }))
      await fs.mkdir(outside, { recursive: true })

      await sweepOrphanedHardRuns(dataRoot, Date.now(), (pid) => pid === 42)

      await expect(fs.stat(stale)).rejects.toThrow()
      expect((await fs.stat(active)).isDirectory()).toBe(true)
      expect((await fs.stat(recent)).isDirectory()).toBe(true)
      expect((await fs.stat(outside)).isDirectory()).toBe(true)
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  })

  test("the sweep unregisters only its own worktrees and leaves the user's unavailable worktree registered (no global prune)", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-hard-prune-test-"))
    const repo = path.join(base, "repo")
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString()
    try {
      await fs.mkdir(repo)
      git(repo, "init", "-q", "-b", "main")
      await fs.writeFile(path.join(repo, "a.txt"), "1")
      git(repo, "add", ".")
      git(repo, "commit", "-qm", "init")
      // the user's own linked worktree, temporarily unavailable (renamed away / unplugged)
      const userWorktree = path.join(base, "feature-wt")
      git(repo, "worktree", "add", "-q", "-b", "feature", userWorktree)
      await fs.rename(userWorktree, `${userWorktree}.away`)
      // a stale hard-mode run created from the same repository
      const dataRoot = path.join(base, "data")
      const run = path.join(dataRoot, "ezk", "hard", "run-x")
      await fs.mkdir(run, { recursive: true })
      const attempt = path.join(run, "attempt-1")
      git(repo, "worktree", "add", "-q", "--detach", attempt, "HEAD")
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
      await fs.utimes(run, old, old)

      await sweepOrphanedHardRuns(dataRoot, Date.now(), () => false)

      await expect(fs.stat(run)).rejects.toThrow()
      const listed = git(repo, "worktree", "list", "--porcelain")
      expect(listed).not.toContain("attempt-1") // ours: gone
      expect(listed).toContain("feature-wt") // the user's: still registered, merely missing
      await fs.rename(`${userWorktree}.away`, userWorktree)
      expect(git(userWorktree, "status", "-s")).toBe("") // and it works again once the folder is back
      expect(git(userWorktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature")
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  test("uses real temporary worktrees, preserves the user's index and applies only the approved candidate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezk-hard-worktree-test-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
    try {
      git("init", "-q")
      git("config", "user.name", "Hard mode test")
      git("config", "user.email", "hard-mode-test@localhost")
      await fs.mkdir(path.join(root, "src"), { recursive: true })
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true })
      await fs.mkdir(path.join(root, "packages/demo/node_modules"), { recursive: true })
      await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\npackages/*/node_modules/\n")
      await fs.writeFile(path.join(root, "node_modules/marker.txt"), "root dependencies\n")
      await fs.writeFile(path.join(root, "packages/demo/node_modules/marker.txt"), "package dependencies\n")
      await fs.writeFile(path.join(root, "src/a.txt"), "base\n")
      await fs.writeFile(path.join(root, "staged.txt"), "base\n")
      git("add", "-A")
      git("commit", "-qm", "initial")
      await fs.writeFile(path.join(root, "src/a.txt"), "local edit\n")
      await fs.writeFile(path.join(root, "staged.txt"), "staged user edit\n")
      git("add", "staged.txt")
      await fs.writeFile(path.join(root, "untracked.txt"), "user file\n")

      const result = await runHardMode({
        root,
        task: "append the candidate line",
        verify,
        model: "mock-flash",
        totalBudgetUSD: 0.5,
        async approveApply() { return true },
      }, {
        totalMemoryBytes: () => 8 * GIB,
        async runAttempt(input) {
          expect(await fs.readFile(path.join(input.directory, "node_modules/marker.txt"), "utf8")).toBe("root dependencies\n")
          expect(await fs.readFile(path.join(input.directory, "packages/demo/node_modules/marker.txt"), "utf8")).toBe("package dependencies\n")
          if (input.attempt === 1) {
            await fs.writeFile(path.join(input.directory, "src/a.txt"), "local edit\ncandidate line\n")
            await fs.writeFile(path.join(input.directory, "src/generated.txt"), "generated candidate\n")
          }
          return { exitCode: input.attempt === 1 ? 0 : 1, costUSD: 0.01, output: "mock gateway response" }
        },
        verifySandboxed: () => true,
        async verify() { return { exitCode: 0, output: "mock verify pass" } },
      })

      expect(result.status).toBe("applied")
      expect(result.chosen?.attempt).toBe(1)
      expect(await fs.readFile(path.join(root, "src/a.txt"), "utf8")).toBe("local edit\ncandidate line\n")
      expect(await fs.readFile(path.join(root, "src/generated.txt"), "utf8")).toBe("generated candidate\n")
      expect(await fs.readFile(path.join(root, "staged.txt"), "utf8")).toBe("staged user edit\n")
      expect(git("diff", "--cached", "--", "staged.txt")).toContain("staged user edit")
      expect(await fs.readFile(path.join(root, "untracked.txt"), "utf8")).toBe("user file\n")
      expect(git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toEqual([
        `worktree ${await fs.realpath(root)}`,
      ])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("mock Flash gateway: verifies three attempts, prunes a failure and duplicate, then applies the cheaper duplicate only after approval", async () => {
    const one = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old()\n+newValue(); // first attempt"
    const duplicate = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n- old()\n+ newValue(); /* equivalent whitespace/comment */"
    const failed = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old()\n+bad()"
    const h = harness({ outcomes: [
      { exitCode: 0, costUSD: 0.02, diff: one, verifyExit: 0 },
      { exitCode: 0, costUSD: 0.02, diff: failed, verifyExit: 1 },
      { exitCode: 0, costUSD: 0.01, diff: duplicate, verifyExit: 0 },
    ] })
    let summary = ""
    let approvalSawDiff = false
    const result = await runHardMode({
      root: "/project",
      task: "change the behavior",
      verify,
      model: "deepseek-v4.1-flash",
      totalBudgetUSD: 0.9,
      onSummary(value) { summary = value },
      async approveApply({ attempt, diff }) {
        approvalSawDiff = attempt === 3 && diff === duplicate
        return true
      },
    }, h.deps)
    expect(h.gatewayCalls.map((call) => call.attempt)).toEqual([1, 2, 3])
    expect(h.gatewayCalls.every((call) => call.model === "deepseek-v4.1-flash")).toBe(true)
    expect(h.maxActive()).toBe(1)
    expect(result.chosen?.attempt).toBe(3)
    expect(result.attempts.map((item) => item.status)).toEqual(["verified", "verify failed (exit 1)", "verified"])
    expect(approvalSawDiff).toBe(true)
    expect(result.applied).toBe(true)
    expect(h.applied()).toBe(duplicate)
    expect(summary).toContain("Attempt 2: verify failed")
    expect(h.workspaceEvents.at(-1)).toBe("cleanup")
  })

  test("stops starting attempts once the total task budget is exhausted", async () => {
    const h = harness({ outcomes: [
      { exitCode: 0, costUSD: 0.02, diff: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b", verifyExit: 0, limit: "budget" },
    ] })
    const result = await runHardMode({ root: "/project", task: "edit", verify, model: "flash", totalBudgetUSD: 0.02 }, h.deps)
    expect(h.gatewayCalls.map((call) => call.attempt)).toEqual([1])
    expect(result.status).toBe("budget-exhausted")
    expect(result.attempts.map((item) => item.status)).toEqual(["budget", "budget", "budget"])
    expect(h.workspaceEvents.at(-1)).toBe("cleanup")
  })

  test("asks the Flash judge only between equal-size verified finalists", async () => {
    const h = harness({ outcomes: [
      { exitCode: 0, costUSD: 0.01, diff: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b", verifyExit: 0 },
      { exitCode: 0, costUSD: 0.01, diff: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-c\n+d", verifyExit: 0 },
      { exitCode: 1, costUSD: 0.01, diff: "", verifyExit: 1 },
    ] })
    let judged: number[] = []
    const result = await runHardMode({ root: "/project", task: "edit", verify, model: "flash", totalBudgetUSD: 0.5 }, {
      ...h.deps,
      async judge(input) {
        judged = input.finalists.map((candidate) => candidate.attempt)
        return { attempt: 2, costUSD: 0.005 }
      },
    })
    expect(judged).toEqual([1, 2])
    expect(result.chosen?.attempt).toBe(2)
    expect(result.totalCostUSD).toBeCloseTo(0.035)
  })

  test("keeps the working tree unchanged when the user declines the selected diff", async () => {
    const h = harness({ outcomes: [
      { exitCode: 0, costUSD: 0.01, diff: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new", verifyExit: 0 },
      { exitCode: 1, costUSD: 0.01, diff: "", verifyExit: 1 },
      { exitCode: 1, costUSD: 0.01, diff: "", verifyExit: 1 },
    ] })
    const result = await runHardMode({
      root: "/project",
      task: "edit",
      verify,
      model: "flash",
      totalBudgetUSD: 0.5,
      async approveApply() { return false },
    }, h.deps)
    expect(result.status).toBe("approval-declined")
    expect(result.applied).toBe(false)
    expect(h.applied()).toBe("")
    expect(h.workspaceEvents.at(-1)).toBe("cleanup")
  })

  test("cancellation aborts the run and cleans up all attempt worktrees", async () => {
    const h = harness()
    const controller = new AbortController()
    const costUpdates: number[] = []
    const deps: HardModeDependencies = {
      ...h.deps,
      async runAttempt(args) {
        controller.abort()
        return { exitCode: 1, costUSD: 0.01, output: "cancelled" }
      },
    }
    await expect(runHardMode({
      root: "/project",
      task: "edit",
      verify,
      model: "flash",
      totalBudgetUSD: 0.5,
      signal: controller.signal,
      onCost: (_runID, totalCostUSD) => {
        costUpdates.push(totalCostUSD)
      },
    }, deps)).rejects.toMatchObject({ name: "AbortError" })
    expect(h.workspaceEvents).toEqual(["cleanup"])
    expect(costUpdates).toEqual([0.01])
  })

  test("a large-memory host may parallelize, while an 8 GB host never does", async () => {
    const h = harness({ memory: 8 * GIB, outcomes: [
      { exitCode: 1, costUSD: 0.01, diff: "", verifyExit: 1 },
      { exitCode: 1, costUSD: 0.01, diff: "", verifyExit: 1 },
      { exitCode: 1, costUSD: 0.01, diff: "", verifyExit: 1 },
    ] })
    await runHardMode({ root: "/project", task: "edit", verify, model: "flash", totalBudgetUSD: 0.5 }, h.deps)
    expect(h.maxActive()).toBe(1)

    const large = harness({ memory: 32 * GIB, outcomes: [
      { exitCode: 1, costUSD: 0.01, diff: "", verifyExit: 1 },
      { exitCode: 1, costUSD: 0.01, diff: "", verifyExit: 1 },
      { exitCode: 1, costUSD: 0.01, diff: "", verifyExit: 1 },
    ] })
    await runHardMode({ root: "/project", task: "edit", verify, model: "flash", totalBudgetUSD: 0.5 }, large.deps)
    expect(large.maxActive()).toBe(3)
  })

  const diffA = "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+new"
  const okOutcomes = () => [
    { exitCode: 0, costUSD: 0.01, diff: diffA, verifyExit: 0 },
    { exitCode: 0, costUSD: 0.01, diff: diffA + "x", verifyExit: 0 },
    { exitCode: 0, costUSD: 0.01, diff: diffA + "y", verifyExit: 0 },
  ]

  test("unsandboxed verify asks naming the edited files; declining is final: later attempts are not asked and every attempt is marked for manual review", async () => {
    const h = harness({ outcomes: okOutcomes() })
    const asked: { command: string; files: string[] }[] = []
    let verified = 0
    const result = await runHardMode({
      root: "/project", task: "edit", verify, model: "flash", totalBudgetUSD: 0.5,
      async confirmVerify(info) { asked.push(info); return false },
    }, { ...h.deps, verifySandboxed: () => false, async verify() { verified++; return { exitCode: 0, output: "" } } })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ command: "bun test", files: ["package.json"] })
    expect(verified).toBe(0)
    expect(result.attempts.every((a) => a.status.startsWith("needs manual review"))).toBe(true)
    expect(result.chosen).toBeUndefined()
  })

  test("unsandboxed verify runs after approval; with no confirm callback (non-interactive) it never runs; sandboxed verify never asks", async () => {
    const run = async (sandboxed: boolean, confirm?: () => Promise<boolean>) => {
      const h = harness({ outcomes: okOutcomes() })
      let verified = 0, asked = 0
      const result = await runHardMode({
        root: "/project", task: "edit", verify, model: "flash", totalBudgetUSD: 0.5,
        ...(confirm ? { async confirmVerify() { asked++; return confirm() } } : {}),
        async approveApply() { return false },
      }, { ...h.deps, verifySandboxed: () => sandboxed, async verify() { verified++; return { exitCode: 0, output: "" } } })
      return { verified, asked, result }
    }
    expect(await run(false, async () => true)).toMatchObject({ verified: 3, asked: 3 }) // one answer per attempt
    expect(await run(false)).toMatchObject({ verified: 0, asked: 0 })
    expect(await run(true, async () => true)).toMatchObject({ verified: 3, asked: 0 })
  })

  test("consent is per attempt: each prompt lists that attempt's own files, prompts never overlap, and approving attempt 1 does not cover attempt 2", async () => {
    const diffFor = (file: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new`
    const h = harness({
      memory: 32 * GIB, // parallel attempts
      outcomes: [
        { exitCode: 0, costUSD: 0.01, diff: diffFor("src/a.ts"), verifyExit: 0 },
        { exitCode: 0, costUSD: 0.01, diff: diffFor("package.json"), verifyExit: 0 },
        { exitCode: 0, costUSD: 0.01, diff: diffFor("Makefile"), verifyExit: 0 },
      ],
    })
    const asked: { attempt: number; files: string[] }[] = []
    let open = 0
    let overlap = 0
    const result = await runHardMode({
      root: "/project", task: "edit", verify, model: "flash", totalBudgetUSD: 0.5,
      async confirmVerify(info) {
        open++
        overlap = Math.max(overlap, open)
        asked.push({ attempt: info.attempt, files: info.files })
        await new Promise((resolve) => setTimeout(resolve, 5))
        open--
        return info.attempt !== 2 // approve 1 and 3, decline 2
      },
      async approveApply() { return false },
    }, { ...h.deps, verifySandboxed: () => false })
    expect(overlap).toBe(1)
    expect(asked.map((item) => item.attempt).sort()).toEqual([1, 2])
    expect(asked.find((item) => item.attempt === 1)!.files).toEqual(["src/a.ts"])
    expect(asked.find((item) => item.attempt === 2)!.files).toEqual(["package.json"])
    // attempt 2 was declined, which is final: attempt 3 (Makefile) is never asked and never verified
    expect(result.attempts.find((a) => a.attempt === 3)!.status).toStartWith("needs manual review")
  })

  test("concurrent path: one failing attempt cancels the others, counts their cost and cleans up only after they stopped", async () => {
    const h = harness({ memory: 32 * GIB, outcomes: okOutcomes() })
    const ws = await h.deps.prepare("", "")
    const events: string[] = []
    const costs: number[] = []
    const sawAbort: boolean[] = []
    const deps: HardModeDependencies = {
      ...h.deps,
      prepare: async () => ({
        ...ws,
        async applicable() { throw new Error("git exploded") },
        async cleanup() { events.push("cleanup"); await ws.cleanup() },
      }),
      async runAttempt(args) {
        if (args.attempt === 1) return { exitCode: 0, costUSD: 0.01, output: "" }
        await new Promise<void>((resolve) => args.signal?.addEventListener("abort", () => resolve(), { once: true }))
        await new Promise((r) => setTimeout(r, 10))
        sawAbort.push(!!args.signal?.aborted)
        events.push(`stopped-${args.attempt}`)
        return { exitCode: 1, costUSD: 0.02, output: "cancelled" }
      },
    }
    await expect(runHardMode({
      root: "/project", task: "edit", verify, model: "flash", totalBudgetUSD: 0.5,
      onCost: (_id, total) => { costs.push(total) },
    }, deps)).rejects.toThrow("git exploded")
    expect(sawAbort).toEqual([true, true])
    expect(events.at(-1)).toBe("cleanup")
    expect(events.filter((e) => e.startsWith("stopped"))).toHaveLength(2)
    expect(costs.at(-1)).toBeCloseTo(0.05) // the cancelled attempts' cost is counted
  })

  test("a diff failure marks that attempt not eligible instead of failing the run", async () => {
    const h = harness({ outcomes: okOutcomes() })
    const ws = await h.deps.prepare("", "")
    const result = await runHardMode({ root: "/project", task: "edit", verify, model: "flash", totalBudgetUSD: 0.5 }, {
      ...h.deps,
      prepare: async () => ({ ...ws, async diff(n: number) { if (n === 2) throw new Error("too big"); return ws.diff(n) } }),
    })
    expect(result.attempts.find((a) => a.attempt === 2)?.status).toContain("not eligible: diff unavailable")
    expect(result.attempts.find((a) => a.attempt === 1)?.status).toBe("verified")
  })
})
