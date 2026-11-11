// A11: run three isolated Flash attempts, verify and prune them, then ask before applying the chosen diff.
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HARD_ATTEMPTS, hardAttemptBudget, hardAttemptConcurrency, hardModeFinalists, type HardCandidate } from "@opencode-ai/core/ezk/loop/hard"
import type { Verify } from "@opencode-ai/core/ezk/context/session-start"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { HeadTailBuffer } from "@opencode-ai/core/ezk/exec/buffer"
import { isProtectedRelative } from "@opencode-ai/core/ezk/safety/protected-paths"
import { Global } from "@opencode-ai/core/global"
import { childEnv } from "@/ezk/safety/env"
import { killTree } from "@opencode-ai/core/ezk/process-tree"
import { redactSecrets } from "@opencode-ai/core/ezkielyna-redact"
import { sandboxFor } from "@opencode-ai/core/ezk/sandbox"
import { runExec } from "./exec-run"

const GIB = 1024 ** 3
const VERIFY_TIMEOUT_MS = 120_000
const ATTEMPT_TIMEOUT_MS = 10 * 60_000
const OUTPUT_BYTES = 256 * 1024
const DIFF_BYTES = 2 * 1024 * 1024
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000
const JUDGE_RESERVE_FRACTION = 0.1
const UNAPPROVED_VERIFY = "not run: the verify command would run unsandboxed on edited files and was not approved"

export type HardAttemptOutput = {
  exitCode: number
  costUSD: number
  output: string
  limit?: "turns" | "budget"
}

export type HardVerification = { exitCode: number | null; output: string; timedOut?: boolean }

export interface HardWorkspace {
  attempts: { attempt: number; directory: string }[]
  diff(attempt: number): Promise<string>
  applicable(diff: string, attempt: number): Promise<{ ok: boolean; paths: string[]; reason?: string }>
  apply(diff: string, attempt: number): Promise<void>
  cleanup(): Promise<void>
}

export interface HardModeDependencies {
  totalMemoryBytes(): number
  prepare(root: string, runID: string, signal?: AbortSignal): Promise<HardWorkspace>
  runAttempt(input: {
    attempt: number
    directory: string
    task: string
    model: string
    budgetUSD: number
    signal?: AbortSignal
  }): Promise<HardAttemptOutput>
  verify(directory: string, command: string, signal?: AbortSignal): Promise<HardVerification>
  /** Whether `verify` runs inside the OS sandbox (network off, writes only in the worktree) for this directory. */
  verifySandboxed(directory: string): boolean
  judge?(input: {
    root: string
    model: string
    finalists: HardCandidate[]
    budgetUSD: number
    signal?: AbortSignal
  }): Promise<{ attempt?: number; costUSD: number }>
}

type HardJudgeInput = Parameters<NonNullable<HardModeDependencies["judge"]>>[0]

export type HardModeInput = {
  root: string
  task: string
  verify: Verify
  model: string
  totalBudgetUSD: number
  signal?: AbortSignal
  onCost?: (runID: string, totalCostUSD: number) => Promise<void> | void
  onSummary?: (summary: string) => Promise<void> | void
  /**
   * Asked per attempt, before its verify run, only when verify cannot run in the OS sandbox: the attempt edited build/test
   * scripts the command may run. Not provided or false: verification is skipped ("needs manual review").
   */
  confirmVerify?: (input: { command: string; files: string[]; attempt: number }) => Promise<boolean>
  approveApply?: (input: { summary: string; attempt: number; diff: string; paths: string[] }) => Promise<boolean>
}

export type HardModeResult = {
  runID: string
  status: "applied" | "approval-declined" | "no-candidate" | "budget-exhausted"
  summary: string
  attempts: { attempt: number; status: string; diffBytes: number; costUSD: number }[]
  chosen?: HardCandidate
  totalCostUSD: number
  applied: boolean
}

/**
 * Forget exactly one worktree that hard mode created, by path: `git worktree remove --force <path>` and, if git still lists it
 * (directory already gone, remove refused), delete only the admin entry whose `gitdir` points at that path. This never runs
 * `git worktree prune`, which would also drop the registration of the user's own worktrees that happen to be unavailable right now.
 */
export async function removeOwnWorktree(repo: string, worktreePath: string) {
  await git(repo, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined)
  const common = (await git(repo, ["rev-parse", "--git-common-dir"]).catch(() => "")).trim()
  if (!common) return
  const adminRoot = path.join(path.resolve(repo, common), "worktrees")
  const canonical = async (target: string) => {
    const real = await fs.realpath(target).catch(() => undefined)
    if (real) return real
    const parent = await fs.realpath(path.dirname(target)).catch(() => path.dirname(target))
    return path.join(parent, path.basename(target))
  }
  const wanted = (await canonical(path.join(worktreePath, ".git"))).toLowerCase()
  for (const entry of await fs.readdir(adminRoot).catch(() => [] as string[])) {
    const gitdir = (await fs.readFile(path.join(adminRoot, entry, "gitdir"), "utf8").catch(() => "")).trim()
    if (!gitdir || (await canonical(gitdir)).toLowerCase() !== wanted) continue
    await fs.rm(path.join(adminRoot, entry), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Remove only expired direct children of `<data>/ezk/hard`, unregistering exactly the worktrees they hold (never a repository-wide prune). */
export async function sweepOrphanedHardRuns(dataRoot = Global.Path.data, now = Date.now(), isAlive = processAlive) {
  const hardRoot = path.resolve(dataRoot, "ezk", "hard")
  const rootStat = await fs.lstat(hardRoot).catch(() => undefined)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return
  const realHardRoot = await fs.realpath(hardRoot).catch(() => "")
  if (!realHardRoot) return

  const entries = await fs.readdir(hardRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runPath = path.resolve(hardRoot, entry.name)
    if (path.dirname(runPath) !== hardRoot) continue
    const stat = await fs.lstat(runPath).catch(() => undefined)
    if (!stat?.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < ORPHAN_AGE_MS) continue
    const owner = await fs.readFile(path.join(runPath, ".owner.json"), "utf8").then((value) => JSON.parse(value) as { pid?: unknown }).catch(() => undefined)
    if (typeof owner?.pid === "number" && Number.isInteger(owner.pid) && isAlive(owner.pid)) continue

    const own: { repo: string; attemptPath: string }[] = []
    const attempts = await fs.readdir(runPath, { withFileTypes: true }).catch(() => [])
    for (const attempt of attempts) {
      if (!attempt.isDirectory() || !/^attempt-\d+$/.test(attempt.name)) continue
      const attemptPath = path.join(runPath, attempt.name)
      const common = await git(attemptPath, ["rev-parse", "--git-common-dir"]).catch(() => "")
      if (!common.trim()) continue
      const commonPath = await fs.realpath(path.resolve(attemptPath, common.trim())).catch(() => "")
      if (commonPath && path.basename(commonPath) === ".git") own.push({ repo: path.dirname(commonPath), attemptPath })
    }

    const realRun = await fs.realpath(runPath).catch(() => "")
    if (!realRun || path.dirname(realRun) !== realHardRoot) continue
    // Unregister our worktrees by path first (this also deletes their folders), then delete whatever is left of the run folder.
    for (const item of own) await removeOwnWorktree(item.repo, item.attemptPath)
    await fs.rm(realRun, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function runHardMode(input: HardModeInput, overrides: Partial<HardModeDependencies> = {}): Promise<HardModeResult> {
  const deps = { ...actualDependencies, ...overrides }
  if (!input.task.trim()) throw new Error("Hard mode needs a task.")
  if (!Number.isFinite(input.totalBudgetUSD) || input.totalBudgetUSD <= 0) throw new Error("Hard mode needs a positive remaining cost cap.")
  throwIfAborted(input.signal)
  const runID = randomUUID()
  const workspace = await deps.prepare(path.resolve(input.root), runID, input.signal)
  let spent = 0
  let budgetExhausted = false
  let chosen: HardCandidate | undefined
  let summary = ""
  let applied = false
  const rows: HardModeResult["attempts"] = []
  // One failing attempt cancels the others (they stop, their cost is still counted) before the worktrees are removed.
  const stop = new AbortController()
  const relay = () => stop.abort()
  if (input.signal?.aborted) stop.abort()
  else input.signal?.addEventListener("abort", relay, { once: true })
  const signal = stop.signal
  let consentQueue: Promise<unknown> = Promise.resolve()
  let verifyDeclined = false
  try {
    const attempts = new Map(workspace.attempts.map((item) => [item.attempt, item]))
    const concurrency = hardAttemptConcurrency(deps.totalMemoryBytes())
    const attemptBudgetCap = input.totalBudgetUSD * (1 - JUDGE_RESERVE_FRACTION)
    const results: HardCandidate[] = []
    let next = 1
    // Unsandboxed verify runs the (possibly model-edited) build scripts with the user's rights. Consent is per attempt and names THAT attempt's
    // edited files (an answer for attempt 1 says nothing about the scripts attempt 2 changed). Prompts are serialised so parallel attempts never
    // stack dialogs, and a "no" is final for the rest of the run.
    const askVerify = (attempt: number) => {
      const ask = async () => {
        if (verifyDeclined) return false
        const files = diffPaths(await workspace.diff(attempt).catch(() => ""))
        const granted = (await input.confirmVerify?.({ command: input.verify.command, files, attempt })) === true
        if (!granted) verifyDeclined = true
        return granted
      }
      const answer = consentQueue.then(ask, ask)
      consentQueue = answer.catch(() => undefined)
      return answer
    }
    const runOne = async (attempt: number, fixedBudget?: number) => {
      throwIfAborted(signal)
      const remaining = HARD_ATTEMPTS - attempt + 1
      const budgetUSD = fixedBudget ?? hardAttemptBudget(attemptBudgetCap, spent, remaining)
      if (budgetUSD <= 0 || spent >= input.totalBudgetUSD) {
        budgetExhausted = true
        rows.push({ attempt, status: "budget", diffBytes: 0, costUSD: 0 })
        return
      }
      const dir = attempts.get(attempt)?.directory
      if (!dir) throw new Error(`Hard mode worktree ${attempt} was not created.`)
      let run: HardAttemptOutput
      try {
        run = await deps.runAttempt({ attempt, directory: dir, task: input.task, model: input.model, budgetUSD, signal })
      } catch (error) {
        if (signal.aborted) throw abortError()
        run = { exitCode: 1, costUSD: 0, output: errorMessage(error) }
      }
      const cost = finiteCost(run.costUSD)
      spent += cost
      await input.onCost?.(runID, spent)
      throwIfAborted(signal)
      let verification: HardVerification = { exitCode: null, output: "not run: attempt did not finish successfully" }
      if (run.exitCode === 0 && !run.limit && spent <= input.totalBudgetUSD) {
        const allowed = deps.verifySandboxed(dir) || (await askVerify(attempt))
        verification = allowed
          ? await deps.verify(dir, input.verify.command, signal)
          : { exitCode: null, output: UNAPPROVED_VERIFY }
      } else if (run.limit === "budget") {
        verification = { exitCode: null, output: "attempt stopped at its budget" }
      } else if (run.limit === "turns") {
        verification = { exitCode: null, output: "attempt reached its turn limit" }
      }
      const diffResult = await workspace.diff(attempt).then((text) => ({ text }), (error) => ({ text: "", error: errorMessage(error) }))
      const diff = diffResult.text
      const check = "error" in diffResult
        ? { ok: false, paths: [], reason: `diff unavailable (${diffResult.error})` }
        : diff ? await workspace.applicable(diff, attempt) : { ok: false, paths: [], reason: "empty diff" }
      const needsReview = verification.output === UNAPPROVED_VERIFY
      const verified = run.exitCode === 0 && !run.limit && verification.exitCode === 0 && !verification.timedOut && check.ok
      const status = verified
        ? "verified"
        : !check.ok
          ? `not eligible: ${check.reason ?? "diff cannot be safely applied"}`
          : run.limit === "budget"
            ? "budget"
            : needsReview
              ? "needs manual review: verify not run"
              : run.exitCode !== 0
              ? `attempt failed (exit ${run.exitCode})`
              : verification.timedOut
                ? "verify timed out"
                : `verify failed (exit ${verification.exitCode ?? "unknown"})`
      rows.push({ attempt, status, diffBytes: Buffer.byteLength(diff, "utf8"), costUSD: cost })
      const candidate: HardCandidate = { attempt, verified, diff, costUSD: cost }
      ;(results as HardCandidate[]).push(candidate)
    }

    if (concurrency === 1) {
      while (next <= HARD_ATTEMPTS) {
        const attempt = next++
        if (spent >= attemptBudgetCap) {
          rows.push({ attempt, status: "budget", diffBytes: 0, costUSD: 0 })
          budgetExhausted = true
          continue
        }
        await runOne(attempt)
      }
    } else {
      const fixedBudget = attemptBudgetCap / HARD_ATTEMPTS
      let firstError: { error: unknown } | undefined
      const workers = Array.from({ length: Math.min(concurrency, HARD_ATTEMPTS) }, async () => {
        try {
          while (next <= HARD_ATTEMPTS) {
            throwIfAborted(signal)
            const attempt = next++
            await runOne(attempt, fixedBudget)
          }
        } catch (error) {
          firstError ??= { error }
          stop.abort()
        }
      })
      await Promise.all(workers) // each worker settles (its cost is counted) before the worktrees are removed
      if (firstError) throw firstError.error
    }

    let finalists = hardModeFinalists(results)
    if (finalists.length > 1 && deps.judge && spent < input.totalBudgetUSD) {
      const decision = await deps.judge({
        root: input.root,
        model: input.model,
        finalists,
        budgetUSD: input.totalBudgetUSD - spent,
        signal,
      })
      spent += finiteCost(decision.costUSD)
      await input.onCost?.(runID, spent)
      if (decision.attempt !== undefined) finalists = finalists.filter((item) => item.attempt === decision.attempt)
    }
    chosen = finalists[0]
    const orderedRows = rows.toSorted((a, b) => a.attempt - b.attempt)
    summary = formatSummary(orderedRows, chosen, spent, input.totalBudgetUSD, input.verify.command, concurrency)
    if (!chosen) {
      await input.onSummary?.(summary)
      return {
        runID,
        status: budgetExhausted || spent >= input.totalBudgetUSD ? "budget-exhausted" : "no-candidate",
        summary,
        attempts: orderedRows,
        totalCostUSD: spent,
        applied: false,
      }
    }

    const selected = await workspace.applicable(chosen.diff, chosen.attempt)
    if (!selected.ok) {
      summary += `\n\nSelected diff cannot be applied safely: ${selected.reason ?? "validation failed"}.`
      await input.onSummary?.(summary)
      return { runID, status: "no-candidate", summary, attempts: orderedRows, chosen, totalCostUSD: spent, applied: false }
    }
    await input.onSummary?.(summary)
    const approved = await input.approveApply?.({ summary, attempt: chosen.attempt, diff: chosen.diff, paths: selected.paths })
    if (!approved) {
      summary += "\n\nThe selected diff was not applied; the original working tree is unchanged."
      return { runID, status: "approval-declined", summary, attempts: orderedRows, chosen, totalCostUSD: spent, applied: false }
    }
    await workspace.apply(chosen.diff, chosen.attempt)
    applied = true
    summary += `\n\nApplied attempt ${chosen.attempt} to the working tree after approval.`
    return { runID, status: "applied", summary, attempts: orderedRows, chosen, totalCostUSD: spent, applied }
  } finally {
    stop.abort()
    input.signal?.removeEventListener("abort", relay)
    await workspace.cleanup()
  }
}

const actualDependencies: HardModeDependencies = {
  totalMemoryBytes: () => os.totalmem(),
  prepare: createWorkspace,
  runAttempt: async (input) => {
    const output = new HeadTailBuffer(OUTPUT_BYTES)
    let metrics: { costUSD: number; turns: number; limit?: "turns" | "budget" } = { costUSD: 0, turns: 0 }
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    let exitCode: number
    try {
      exitCode = await runExec({
        prompt: attemptPrompt(input),
        directory: input.directory,
        json: false,
        maxTurns: 12,
        maxBudgetUSD: input.budgetUSD,
        mode: "acceptEdits",
        model: `${EZK.providerID}/${input.model}`,
        trusted: true,
        signal,
        write: (line) => output.write(`${line}\n`),
        log: (line) => output.write(`${line}\n`),
        onMetrics: (value) => (metrics = value),
      })
    } catch (error) {
      if (signal.aborted) return { exitCode: 1, costUSD: metrics.costUSD, output: errorMessage(error), ...(metrics.limit ? { limit: metrics.limit } : {}) }
      throw error
    }
    return { exitCode, output: output.slice().text, ...metrics }
  },
  verify: runVerify,
  verifySandboxed: (directory) => verifyPlan(directory, "true").wrap !== null,
  judge: runJudge,
}

function attemptPrompt(input: { attempt: number; task: string }) {
  return [
    `Hard mode attempt ${input.attempt} of ${HARD_ATTEMPTS}.`,
    "Make a focused implementation of the user's task in this isolated worktree. Do not commit, push, or change files outside the project directory.",
    "Do not run the project's verify command. The coordinator will run the detected command after your edits.",
    `Task:\n${input.task}`,
  ].join("\n\n")
}

async function runJudge(input: HardJudgeInput) {
  const candidates = input.finalists.map((item) => ({ attempt: item.attempt, diff: clip(item.diff, 24_000) }))
  const allowed = candidates.map((item) => item.attempt)
  const schema = {
    type: "object",
    required: ["attempt"],
    properties: { attempt: { type: "integer", enum: allowed } },
    additionalProperties: false,
  }
  let answer = ""
  let metrics: { costUSD: number; turns: number; limit?: "turns" | "budget" } = { costUSD: 0, turns: 0 }
  await runExec({
    prompt: [
      "Choose the best verified implementation from these equal-size diffs.",
      "Rubric: correctness against the task, smallest behavioral risk, maintainability. Pick exactly one attempt number.",
      JSON.stringify(candidates),
    ].join("\n\n"),
    directory: input.root,
    json: false,
    schema,
    maxTurns: 2,
    maxBudgetUSD: input.budgetUSD,
    mode: "ask",
    model: `${EZK.providerID}/${input.model}`,
    write: (line) => (answer += `${line}\n`),
    log: () => {},
    onMetrics: (value) => (metrics = value),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  let attempt: number | undefined
  try {
    const parsed = JSON.parse(answer) as { attempt?: number }
    if (typeof parsed.attempt === "number" && allowed.includes(parsed.attempt)) attempt = parsed.attempt
  } catch {}
  return { attempt, costUSD: finiteCost(metrics.costUSD) }
}

// The attempt's scripts run here after the model edited them: inside the OS sandbox (no network, writes only in the worktree
// and the temp dir) whenever one is available, like the shell tool in Edit-otomatis mode.
function verifyPlan(directory: string, command: string) {
  return sandboxFor(command, "acceptEdits", directory, { cwd: directory, shell: "/bin/sh" })
}

async function runVerify(directory: string, command: string, signal?: AbortSignal): Promise<HardVerification> {
  const win = process.platform === "win32"
  const shell = win ? process.env.ComSpec || "cmd.exe" : "/bin/sh"
  const wrap = win ? null : verifyPlan(directory, command).wrap
  const args = win ? ["/d", "/s", "/c", command] : wrap ? [...wrap.slice(1), shell, "-c", command] : ["-c", command]
  const result = await runProcess(wrap ? wrap[0]! : shell, args, {
    cwd: directory,
    env: childEnv(process.env),
    timeoutMs: VERIFY_TIMEOUT_MS,
    signal,
  })
  return { exitCode: result.exitCode, output: result.output, timedOut: result.timedOut }
}

async function createWorkspace(root: string, runID: string, signal?: AbortSignal): Promise<HardWorkspace> {
  await sweepOrphanedHardRuns()
  const rootReal = await fs.realpath(root)
  const repoRoot = await fs.realpath((await git(rootReal, ["rev-parse", "--show-toplevel"], signal)).trim())
  const head = (await git(repoRoot, ["rev-parse", "HEAD"], signal)).trim()
  const projectRel = path.relative(repoRoot, rootReal).split(path.sep).join("/") || "."
  if (projectRel === ".." || projectRel.startsWith("../") || path.isAbsolute(projectRel)) {
    throw new Error("Hard mode project root must be inside its Git worktree.")
  }
  const changed = await git(repoRoot, ["diff", "--name-only", "-z", "HEAD", "--"], signal)
  const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], signal)
  const untrackedPaths = untracked.split("\0").filter((file) => file && !dependencyPath(file))
  const changedPaths = [...changed.split("\0"), ...untrackedPaths].filter(Boolean)
  if (changedPaths.some(dependencyPath)) throw new Error("Hard mode cannot snapshot changes inside node_modules.")
  if (changedPaths.some(secretLikePath)) throw new Error("Hard mode cannot snapshot while secret-looking files have uncommitted changes.")
  const trackedPatch = await git(repoRoot, ["diff", "--binary", "HEAD", "--"], signal, undefined, DIFF_BYTES)
  if (redactSecrets(trackedPatch) !== trackedPatch) throw new Error("Hard mode cannot snapshot uncommitted changes that appear to contain secrets.")
  for (const file of untrackedPaths) {
    const filePath = path.join(repoRoot, file)
    const stat = await fs.lstat(filePath).catch(() => undefined)
    if (!stat) continue
    if (stat.size > DIFF_BYTES) throw new Error("Hard mode cannot snapshot an untracked file larger than its 2 MiB safety limit.")
    const content = stat.isSymbolicLink() ? await fs.readlink(filePath) : stat.isFile() ? (await fs.readFile(filePath)).toString("utf8") : ""
    if (redactSecrets(content) !== content) {
      throw new Error("Hard mode cannot snapshot uncommitted changes that appear to contain secrets.")
    }
  }

  const dataRoot = path.join(Global.Path.data, "ezk", "hard", runID)
  const attemptDirs: { attempt: number; directory: string }[] = []
  const worktreeDirs: string[] = []
  try {
    await fs.mkdir(dataRoot, { recursive: true })
    await fs.writeFile(path.join(dataRoot, ".owner.json"), JSON.stringify({ pid: process.pid }))
    for (let attempt = 1; attempt <= HARD_ATTEMPTS; attempt++) {
      throwIfAborted(signal)
      const directory = path.join(dataRoot, `attempt-${attempt}`)
      await git(repoRoot, ["worktree", "add", "--detach", directory, head], signal)
      worktreeDirs.push(directory)
      if (trackedPatch) {
        const copied = await runGitInput(directory, ["apply", "--binary", "--whitespace=nowarn", "-"], trackedPatch, signal)
        if (copied.exitCode !== 0) throw new Error(`Could not copy the initial tracked changes into an attempt: ${clip(copied.output, 2000)}`)
      }
      await copyUntracked(repoRoot, directory, untrackedPaths, signal)
      await git(directory, ["add", "-A", "--", ".", ":(exclude)node_modules", ":(exclude)**/node_modules"], signal)
      await copyDependencies(repoRoot, directory, signal)
      const projectDirectory = projectRel === "." ? directory : path.join(directory, projectRel)
      attemptDirs.push({ attempt, directory: projectDirectory })
    }
  } catch (error) {
    await Promise.all(worktreeDirs.map((directory) => removeOwnWorktree(repoRoot, directory).catch(() => {})))
    await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  const attemptRoots = worktreeDirs
  return {
    attempts: attemptDirs,
    async diff(attempt) {
      throwIfAborted(signal)
      const rootDir = attemptRoots[attempt - 1]!
      const untracked = (await git(rootDir, ["ls-files", "--others", "--exclude-standard", "-z"], signal))
        .split("\0")
        .filter((file) => file && !dependencyPath(file))
      if (untracked.length) {
        const result = await runGitInput(rootDir, ["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"], untracked.join("\0"), signal)
        if (result.exitCode !== 0) throw new Error(`Could not include newly created files in the attempt diff: ${clip(result.output, 2000)}`)
      }
      return git(rootDir, ["diff", "--binary", "--no-ext-diff", "--", ".", ":(exclude)node_modules", ":(exclude)**/node_modules"], signal, undefined, DIFF_BYTES)
    },
    async applicable(diff, attempt) {
      if (redactSecrets(diff) !== diff) return { ok: false, paths: [], reason: "candidate diff appears to contain secret material" }
      const attemptRoot = attemptRoots[attempt - 1]!
      const nameOutput = await git(attemptRoot, ["diff", "--name-only", "-z", "--no-renames", "--", ".", ":(exclude)node_modules", ":(exclude)**/node_modules"], signal)
      const paths = nameOutput.split("\0").filter(Boolean)
      if (paths.some((file) => projectRel !== "." && file !== projectRel && !file.startsWith(`${projectRel}/`))) {
        return { ok: false, paths, reason: "attempt changed a file outside the selected project directory" }
      }
      const relative = paths.map((file) => projectRel === "." ? file : path.relative(projectRel, file))
      if (relative.some(isProtectedRelative)) return { ok: false, paths: relative, reason: "attempt touched a protected path" }
      const check = await runGitInput(repoRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], diff, signal)
      return { ok: check.exitCode === 0, paths: relative, ...(check.exitCode !== 0 ? { reason: clip(check.output, 2000) || "diff no longer matches the current working tree" } : {}) }
    },
    async apply(diff) {
      const check = await runGitInput(repoRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], diff, signal)
      if (check.exitCode !== 0) throw new Error(`The working tree changed before approval; selected diff was not applied. ${clip(check.output, 2000)}`)
      const applied = await runGitInput(repoRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], diff, signal)
      if (applied.exitCode !== 0) throw new Error(`Could not apply the selected diff: ${clip(applied.output, 2000)}`)
    },
    async cleanup() {
      try {
        for (const worktree of attemptRoots) await removeOwnWorktree(repoRoot, worktree).catch(() => {})
      } finally {
        await fs.rm(dataRoot, { recursive: true, force: true })
      }
    },
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function copyUntracked(repoRoot: string, worktreeRoot: string, files: string[], signal?: AbortSignal) {
  for (const file of files) {
    throwIfAborted(signal)
    if (dependencyPath(file)) continue
    const source = path.resolve(repoRoot, file)
    const relative = path.relative(repoRoot, source)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Hard mode found an untracked path outside the project worktree.")
    }
    const stat = await fs.lstat(source).catch(() => undefined)
    if (!stat) continue
    const destination = path.join(worktreeRoot, relative)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    if (stat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(source), destination)
      continue
    }
    if (!stat.isFile()) throw new Error(`Hard mode cannot snapshot the special untracked file ${file}.`)
    await fs.copyFile(source, destination)
    await fs.chmod(destination, stat.mode & 0o777)
  }
}

async function copyDependencies(repoRoot: string, worktreeRoot: string, signal?: AbortSignal) {
  const packageRoot = path.join(repoRoot, "packages")
  const sources = [path.join(repoRoot, "node_modules")]
  const pending = [packageRoot]
  while (pending.length) {
    const current = pending.pop()!
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") continue
      const directory = path.join(current, entry.name)
      if (entry.name === "node_modules") sources.push(directory)
      else pending.push(directory)
    }
  }
  for (const source of sources) {
    const stat = await fs.stat(source).catch(() => undefined)
    if (!stat?.isDirectory()) continue
    throwIfAborted(signal)
    const destination = path.join(worktreeRoot, path.relative(repoRoot, source))
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const realSource = await fs.realpath(source)
    if (process.platform === "darwin") {
      const result = await runProcess("cp", ["-c", "-R", realSource, destination], {
        cwd: repoRoot,
        env: childEnv(process.env),
        signal,
        timeoutMs: 120_000,
      })
      if (result.exitCode !== 0) throw new Error(`Could not copy dependencies into an isolated worktree: ${clip(result.output, 2000)}`)
      continue
    }
    await fs.cp(realSource, destination, { recursive: true, errorOnExist: true, force: false })
  }
}

function dependencyPath(file: string) {
  return file.split("/").includes("node_modules")
}

async function git(cwd: string, args: string[], signal?: AbortSignal, env?: Record<string, string>, maxBytes = OUTPUT_BYTES) {
  const result = await runProcess("git", args, { cwd, env: env ?? childEnv(process.env), signal, timeoutMs: 30_000, maxBytes })
  if (result.truncated) throw new Error("Hard mode Git output exceeded its safety limit.")
  if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${clip(result.output, 4000)}`)
  return result.output
}

async function runGitInput(cwd: string, args: string[], input: string, signal?: AbortSignal) {
  return runProcess("git", args, { cwd, env: childEnv(process.env), input, signal, timeoutMs: 30_000, maxBytes: 12_000 })
}

function runProcess(file: string, args: string[], options: {
  cwd: string
  env?: Record<string, string>
  input?: string
  signal?: AbortSignal
  timeoutMs: number
  maxBytes?: number
}): Promise<{ exitCode: number | null; output: string; timedOut?: boolean; truncated?: boolean }> {
  throwIfAborted(options.signal)
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? childEnv(process.env),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const output = new HeadTailBuffer(options.maxBytes ?? OUTPUT_BYTES)
    let timedOut = false
    let settled = false
    const stop = () => child.pid ? killTree(child.pid) : child.kill("SIGTERM")
    const abort = () => stop()
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    options.signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => output.write(chunk))
    child.stderr.on("data", (chunk: Buffer) => output.write(chunk))
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      if (options.signal?.aborted) return reject(abortError())
      resolve({
        exitCode: code,
        output: output.slice().text,
        ...(timedOut ? { timedOut: true } : {}),
        ...(output.total > output.limit ? { truncated: true } : {}),
      })
    })
    if (options.signal?.aborted) stop()
    if (options.input === undefined) child.stdin.end()
    else child.stdin.end(options.input)
  })
}

function formatSummary(
  attempts: HardModeResult["attempts"],
  chosen: HardCandidate | undefined,
  spent: number,
  budget: number,
  verifyCommand: string,
  concurrency: number,
) {
  const lines = [
    `Hard mode: ${HARD_ATTEMPTS} Flash attempts, ${concurrency === 1 ? "sequential" : "parallel"}; verify: ${verifyCommand}`,
    `Budget used: $${spent.toFixed(4)} / $${budget.toFixed(4)}`,
    "",
    ...attempts.map((item) => `Attempt ${item.attempt}: ${item.status}; diff ${item.diffBytes} bytes; cost $${item.costUSD.toFixed(4)}`),
    "",
    chosen ? `Selected attempt ${chosen.attempt} (smallest verified diff; equal-size ties use a Flash judge).` : "No verified, applicable diff was selected.",
  ]
  return lines.join("\n")
}

function secretLikePath(file: string) {
  const base = path.basename(file).toLowerCase()
  if (base === ".env" || (/^\.env\./.test(base) && !/^\.env\.(?:example|sample|template)$/.test(base))) return true
  return /(^|\/)(?:\.npmrc|\.netrc|id_rsa|id_ed25519|credentials?|secrets?)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i.test(file)
}

function finiteCost(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function clip(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.floor(max / 2))}\n[… output clipped …]\n${value.slice(-Math.floor(max / 2))}`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Paths named in a unified/git diff, for the "attempts edited these files" notice. */
export function diffPaths(diff: string) {
  const out = new Set<string>()
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line) ?? /^\+\+\+ b\/(.+)$/.exec(line)
    if (m) out.add(m[m.length - 1]!)
  }
  return [...out]
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

function abortError() {
  return new DOMException("Hard mode cancelled.", "AbortError")
}
