// Entry point of the action: validates inputs, runs `ezkielyna exec --json`, then posts the comment or opens the draft PR.
// EZK_ACTION_DRY_RUN=1: no install, no GitHub API calls, no git push; actions are written to $EZK_ACTION_DRY_OUT (or stdout).
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  validateInputs, parseEvents, formatSummary, parseReviewResult, formatReviewComment, upsertComment, makeApi,
  fixBranchName, assertSafeBranch, redact, capDiff, buildReviewPrompt, buildFixCiPrompt, tailLog, isProjectConfigPath,
} from "../lib/lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const env = process.env
const dry = env.EZK_ACTION_DRY_RUN === "1"
const secrets = [env.EZK_INPUT_API_KEY, env.EZK_INPUT_GITHUB_TOKEN]
const log = (s) => console.log(redact(s, secrets))
const fail = (s) => { console.log(`::error title=Ezkielyna Agent::${redact(s, secrets).replace(/\n/g, " ")}`); process.exit(1) }

function setOutput(name, value) {
  const f = env.GITHUB_OUTPUT
  if (!f) return
  const d = `EZK_EOF_${Math.random().toString(36).slice(2)}`
  appendFileSync(f, `${name}<<${d}\n${redact(value, secrets)}\n${d}\n`)
}
function summary(md) { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, redact(md, secrets) + "\n") }
function emitDry(obj) {
  const line = `DRYRUN ${JSON.stringify(obj)}\n`
  if (env.EZK_ACTION_DRY_OUT) appendFileSync(env.EZK_ACTION_DRY_OUT, line); else process.stdout.write(line)
}
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts })
const git = (...a) => { const r = sh("git", a); if (r.status !== 0) throw new Error(`git ${a[0]} failed: ${redact(r.stderr, secrets).trim()}`); return r.stdout }

const v = validateInputs(
  {
    mode: env.EZK_INPUT_MODE, prompt: env.EZK_INPUT_PROMPT, model: env.EZK_INPUT_MODEL, maxBudget: env.EZK_INPUT_MAX_BUDGET,
    maxTurns: env.EZK_INPUT_MAX_TURNS, permissionMode: env.EZK_INPUT_PERMISSION_MODE, version: env.EZK_INPUT_VERSION, apiKey: env.EZK_INPUT_API_KEY,
  },
  { dryRun: dry },
)
if (!v.ok) fail(v.errors.join("; "))
const cfg = v.config

const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {}
const [owner, repo] = (env.GITHUB_REPOSITORY || "o/r").split("/")
const api = dry ? undefined : makeApi(env.EZK_INPUT_GITHUB_TOKEN)

// ---- build the prompt --------------------------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "ezk-action-"))
let prompt = cfg.prompt
let schemaFile
let prNumber
let fixCtx

if (cfg.mode === "review") {
  prNumber = event.pull_request?.number ?? (env.EZK_PR_NUMBER ? Number(env.EZK_PR_NUMBER) : undefined)
  if (!prNumber) fail("mode review needs a pull_request event")
  let diff
  if (env.EZK_ACTION_DIFF_FILE) diff = readFileSync(env.EZK_ACTION_DIFF_FILE, "utf8")
  else {
    const base = event.pull_request?.base?.sha
    const r = base ? sh("git", ["diff", "--no-color", `${base}...HEAD`]) : { status: 1 }
    if (r.status === 0) diff = r.stdout
    else {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
        headers: { authorization: `Bearer ${env.EZK_INPUT_GITHUB_TOKEN}`, accept: "application/vnd.github.v3.diff", "user-agent": "ezkielyna-agent-action" },
      })
      if (!res.ok) fail(`could not read the pull request diff (${res.status}). Use actions/checkout with fetch-depth: 0.`)
      diff = await res.text()
    }
  }
  if (!diff.trim()) {
    log("The diff is empty; nothing to review.")
    setOutput("result", ""); setOutput("exit-code", "0"); setOutput("turns", "0"); setOutput("cost-usd", "")
    process.exit(0)
  }
  const capped = capDiff(diff)
  prompt = buildReviewPrompt(capped.text, capped.truncated) + (cfg.prompt ? `\nExtra context from the maintainer: ${cfg.prompt}\n` : "")
  schemaFile = join(work, "review-schema.json")
  writeFileSync(schemaFile, readFileSync(join(here, "..", "lib", "review-schema.json")))
} else if (cfg.mode === "fix-ci") {
  let logText
  if (env.EZK_INPUT_LOG_FILE) {
    if (!existsSync(env.EZK_INPUT_LOG_FILE)) fail(`log-file not found: ${env.EZK_INPUT_LOG_FILE}`)
    logText = readFileSync(env.EZK_INPUT_LOG_FILE, "utf8")
  } else if (dry) fail("dry run needs log-file for fix-ci")
  else {
    const runId = env.EZK_INPUT_RUN_ID || event.workflow_run?.id || env.GITHUB_RUN_ID
    const jobs = await api.request("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`)
    const bad = (jobs.jobs || []).filter((j) => j.conclusion === "failure")
    if (!bad.length) fail(`run ${runId} has no failed job`)
    logText = ""
    for (const j of bad.slice(0, 3)) {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${j.id}/logs`, {
        headers: { authorization: `Bearer ${env.EZK_INPUT_GITHUB_TOKEN}`, "user-agent": "ezkielyna-agent-action" }, redirect: "follow",
      })
      if (!res.ok) fail(`could not download the log of job ${j.name} (${res.status})`)
      logText += `\n=== job: ${j.name} ===\n${await res.text()}`
    }
  }
  prompt = buildFixCiPrompt(tailLog(logText), cfg.prompt)
  fixCtx = {
    headRef: event.workflow_run?.head_branch || event.pull_request?.head?.ref || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "",
    runId: env.EZK_INPUT_RUN_ID || event.workflow_run?.id || env.GITHUB_RUN_ID || "0",
  }
}

// ---- fix-ci: never let the failing branch's own project config run with the key ------------------------------------
// The checkout is the failing branch. Its ezkielyna.json*, opencode.json*, .ezkielyna/, .opencode/ and .mcp.json (plugins, MCP servers,
// provider URLs) would be honored once the folder is trusted, with the API key in the child's environment. So they are put back to the
// default branch's version (or deleted when it has none) before `exec`; trust then covers edits to code only.
const trustProject = /^(true|1|yes)$/i.test((env.EZK_INPUT_TRUST_PROJECT || "").trim())
const defaultBranchName = event.repository?.default_branch || env.EZK_DEFAULT_BRANCH || "main"
if (cfg.mode === "fix-ci" && !trustProject) {
  try { restoreProjectConfig() } catch (e) { fail(`could not reset the project config to the default branch: ${e.message}. Set trust-project: true only if you accept the checked-out branch's config.`) }
}
function restoreProjectConfig() {
  let ref = env.EZK_DEFAULT_REF
  if (!ref) {
    if (dry) ref = `origin/${defaultBranchName}`
    else {
      const url = `https://x-access-token:${env.EZK_INPUT_GITHUB_TOKEN}@github.com/${owner}/${repo}.git`
      const f = sh("git", ["fetch", "--quiet", "--depth=1", url, `refs/heads/${defaultBranchName}`])
      if (f.status !== 0) throw new Error(`git fetch of ${defaultBranchName} failed: ${redact(f.stderr, secrets).trim()}`)
      ref = "FETCH_HEAD"
    }
  }
  const inRef = new Set(git("ls-tree", "-r", "-z", "--name-only", ref).split("\0").filter(isProjectConfigPath))
  // -c -o without --exclude-standard: ignored files are honored by the CLI as well.
  const onDisk = git("ls-files", "-z", "-c", "-o", "--", ".").split("\0").filter(isProjectConfigPath)
  for (const f of new Set([...onDisk, ...inRef])) {
    if (f.split("/").includes("..") || f.startsWith("/")) continue
    // a symlinked ancestor would redirect the rm/write below outside the config paths: unlink such links first
    const parts = f.split("/")
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join("/")
      try { if (lstatSync(anc).isSymbolicLink()) rmSync(anc, { force: true }) } catch {}
    }
    rmSync(f, { recursive: true, force: true }) // removes a symlink itself, never its target
    if (inRef.has(f)) {
      const r = spawnSync("git", ["show", `${ref}:${f}`], { maxBuffer: 64 * 1024 * 1024 })
      if (r.status !== 0) throw new Error(`git show ${f} failed`)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, r.stdout)
    }
  }
}

// ---- run the CLI --------------------------------------------------------------------------------------------------
const outFile = join(work, "last-message.txt")
const args = ["exec", "--json", "-m", cfg.model, "--permission-mode", cfg.permissionMode, "--max-budget", String(cfg.maxBudget), "-o", outFile]
if (cfg.maxTurns) args.push("--max-turns", String(cfg.maxTurns))
if (schemaFile) args.push("--output-schema", schemaFile)
args.push("-")

const child = spawn("ezkielyna", args, {
  env: {
    ...env,
    EZKIELYNA_API_KEY: env.EZK_INPUT_API_KEY || env.EZKIELYNA_API_KEY || "",
    EZK_INPUT_API_KEY: "",
    EZK_INPUT_GITHUB_TOKEN: "",
    // `exec` treats a folder that is not trusted as "ask" (= deny) whatever the mode. fix-ci edits files, so its checkout is marked
    // trusted for this one process, but only after the project config was reset to the default branch (see above), or when the
    // maintainer opted in with trust-project. review and custom stay untrusted.
    EZK_TRUST_PROJECT: cfg.mode === "fix-ci" ? "1" : "",
  },
  stdio: ["pipe", "pipe", "pipe"],
})
child.stdin.end(prompt)
let stdout = ""
let stderr = ""
child.stdout.on("data", (d) => (stdout += d))
child.stderr.on("data", (d) => (stderr += d))
const exitCode = await new Promise((res) => {
  child.on("error", (e) => { stderr += `\n${e.message}`; res(1) })
  child.on("close", (c) => res(c ?? 1))
})
writeFileSync(join(work, "events.jsonl"), redact(stdout, secrets))
if (stderr.trim()) log(stderr.trim().split("\n").slice(-20).join("\n"))

const parsed = parseEvents(stdout)
let finalText = parsed.result
if (existsSync(outFile)) finalText = readFileSync(outFile, "utf8") || finalText
parsed.result = finalText

// ---- act on the result --------------------------------------------------------------------------------------------
let outcome = ""
if (cfg.mode === "review" && exitCode !== 1) {
  const review = parseReviewResult(finalText)
  const body = formatReviewComment(review, finalText, { model: cfg.model, turns: parsed.turns, sha: env.GITHUB_SHA })
  if (dry) { emitDry({ action: "comment", pr: prNumber, body }); outcome = "comment (dry run)" }
  else {
    const r = await upsertComment(api, { owner, repo, number: prNumber, body })
    outcome = `comment ${r.action}`
  }
} else if (cfg.mode === "fix-ci" && exitCode !== 1) {
  outcome = await proposeFix()
}

async function proposeFix() {
  const changed = git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean)
  const files = changed.map((l) => l.slice(3).replace(/^"|"$/g, ""))
  const usable = files.filter((f) => !f.startsWith(".github/workflows/") && (trustProject || !isProjectConfigPath(f)))
  if (!usable.length) return "no code change proposed"
  const defaultBranch = defaultBranchName
  const branch = assertSafeBranch(fixBranchName(fixCtx.runId), { headRef: fixCtx.headRef, defaultBranch })
  const title = `Ezkielyna: proposed fix for failing CI (run ${fixCtx.runId})`
  const body = `${finalText || "Proposed fix."}\n\n---\nOpened as a draft by the Ezkielyna Agent action. Review the change before merging. Nothing was pushed to \`${fixCtx.headRef || "the default branch"}\`.`
  if (dry) { emitDry({ action: "fix-pr", branch, base: fixCtx.headRef || defaultBranch, files: usable, title }); return "draft PR (dry run)" }
  git("config", "user.name", "ezkielyna-agent[bot]")
  git("config", "user.email", "ezkielyna-agent@users.noreply.github.com")
  git("checkout", "-b", branch)
  git("add", "--", ...usable)
  git("commit", "-m", `fix: proposed change for failing CI (run ${fixCtx.runId})`)
  const url = `https://x-access-token:${env.EZK_INPUT_GITHUB_TOKEN}@github.com/${owner}/${repo}.git`
  const p = sh("git", ["push", url, `HEAD:refs/heads/${branch}`])
  if (p.status !== 0) throw new Error(`git push failed: ${redact(p.stderr, secrets).trim()}`)
  const pr = await api.request("POST", `/repos/${owner}/${repo}/pulls`, { title, head: branch, base: fixCtx.headRef || defaultBranch, body, draft: true })
  return `draft PR ${pr.html_url}`
}

// ---- outputs, summary ---------------------------------------------------------------------------------------------
setOutput("result", finalText)
setOutput("cost-usd", parsed.cost === undefined ? "" : String(parsed.cost))
setOutput("turns", String(parsed.turns))
setOutput("exit-code", String(exitCode))
summary(formatSummary({ mode: cfg.mode, model: cfg.model, parsed, exitCode, outcome }))
log(`Ezkielyna Agent finished: exit ${exitCode}, ${parsed.turns} turns${outcome ? `, ${outcome}` : ""}`)
if (exitCode === 1) fail(`ezkielyna exec failed${parsed.errors[0] ? `: ${parsed.errors[0]}` : ""}`)
if (exitCode === 2 || exitCode === 3) console.log(`::warning title=Ezkielyna Agent::stopped early (exit ${exitCode}); see the job summary`)
