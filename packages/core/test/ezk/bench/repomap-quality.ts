// Repo map (T7) quality on real history: for recent non-merge commits, build the map at the parent commit with the
// commit message as the "task" and ask whether the files the real patch touched appear in the map.
//   task only      : personalised by files/identifiers the message mentions (usually none)
//   one file known : personalised by the first touched file, recall measured on the other touched files
//   random         : expected recall of picking the same number of files at random
//   code_search    : the files among the top-20 hits of `code_search(<commit subject>)`
// Run from packages/core: nice -n 10 bun test/ezk/bench/repomap-quality.ts /path/to/clone [commits=25]
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CodeIndex } from "../../../src/ezk/codeintel/index"
import { buildRepoMap, mentionedFiles, mentionedIdentifiers } from "../../../src/ezk/codeintel/repomap"
import { grammarFor } from "../../../src/ezk/treesitter/loader"

const repo = path.resolve(process.argv[2]!)
const want = Number(process.argv[3] ?? 25)
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-repomap-quality-"))
const tree = path.join(work, "tree")
const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
const SKIP = /(^|\/)(vendor|third_party|node_modules)\/|\.pb\.go$|(^|\/)zz_generated|_generated\.\w+$|\.min\.js$/
const SKIP_SUBJECT = /^(merge|bump|release|chore\(deps|update (dependencies|changelog)|version|revert)/i

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] ?? 0
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

try {
  // Newest first; skip the newest 5 so the tree is not the tip of an in-flight change.
  const log = git(["log", "--no-merges", "--format=@@%H%x09%P%x09%s", "--name-only", "-n", "600"]).split("@@").slice(1)
  const commits = log
    .map((block) => {
      const [head, ...files] = block.trim().split("\n")
      const [sha, parents, subject] = head!.split("\t")
      return { sha: sha!, parent: parents!.split(" ")[0]!, subject: subject ?? "", files: files.filter((f) => f && grammarFor(f) && !SKIP.test(f)) }
    })
    .slice(5)
    .filter((c) => c.parent && c.files.length >= 1 && c.files.length <= 6 && c.subject.length >= 15 && !SKIP_SUBJECT.test(c.subject))
  git(["worktree", "add", "-q", "--detach", tree, commits[0]!.parent])
  const idx = await CodeIndex.open(path.join(work, "index.db"), tree)
  const rows: { taskOnly: number; oneKnown?: number; random: number; search: number; searchRandom: number; tokens: number; files: number; ms: number }[] = []
  let peak = 0
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20)
  for (const c of commits) {
    if (rows.length >= want) break
    git(["checkout", "-q", "--detach", c.parent], tree)
    await idx.sync()
    const touched = c.files.filter((f) => fs.existsSync(path.join(tree, f)))
    if (!touched.length) continue
    const body = git(["log", "-1", "--format=%B", c.sha]).slice(0, 600)
    const t0 = performance.now()
    const graph = idx.graph()
    const code = graph.files.filter((f) => grammarFor(f) && !SKIP.test(f))
    const task = buildRepoMap({ graph, chatFiles: mentionedFiles(body, graph.files), mentionedIdents: mentionedIdentifiers(body), maxTokens: 1024 })
    const ms = performance.now() - t0
    const inMap = (files: string[], map: { files: string[] }) => files.filter((f) => map.files.includes(f)).length / files.length
    const known = touched.length >= 2 ? buildRepoMap({ graph, chatFiles: [touched[0]!], mentionedIdents: mentionedIdentifiers(body), maxTokens: 1024 }) : undefined
    // code_search (T6) with the commit subject as the query: are the patched files among the top-20 hits?
    const hitFiles = [...new Set(idx.search(c.subject, 20).map((h) => h.path))]
    rows.push({
      search: inMap(touched, { files: hitFiles }),
      searchRandom: Math.min(1, hitFiles.length / Math.max(1, code.length)),
      taskOnly: inMap(touched, task),
      oneKnown: known ? inMap(touched.slice(1), known) : undefined,
      random: Math.min(1, task.files.length / Math.max(1, code.length)),
      tokens: task.tokens,
      files: task.files.length,
      ms,
    })
  }
  clearInterval(timer)
  idx.close()
  const known = rows.flatMap((r) => (r.oneKnown === undefined ? [] : [r.oneKnown]))
  console.log(
    JSON.stringify({
      repo: path.basename(repo),
      commits: rows.length,
      recallTaskOnly: +mean(rows.map((r) => r.taskOnly)).toFixed(3),
      hitRateTaskOnly: +(rows.filter((r) => r.taskOnly > 0).length / rows.length).toFixed(3),
      commitsWithTwoPlusFiles: known.length,
      recallOneFileKnown: +mean(known).toFixed(3),
      hitRateOneFileKnown: +(known.filter((r) => r > 0).length / Math.max(1, known.length)).toFixed(3),
      recallRandom: +mean(rows.map((r) => r.random)).toFixed(3),
      searchRecallAt20: +mean(rows.map((r) => r.search)).toFixed(3),
      searchHitRateAt20: +(rows.filter((r) => r.search > 0).length / rows.length).toFixed(3),
      searchRecallRandom: +mean(rows.map((r) => r.searchRandom)).toFixed(3),
      mapFilesAvg: +mean(rows.map((r) => r.files)).toFixed(1),
      mapTokensAvg: Math.round(mean(rows.map((r) => r.tokens))),
      mapMsP50: Math.round(pct(rows.map((r) => r.ms), 50)),
      mapMsP95: Math.round(pct(rows.map((r) => r.ms), 95)),
      peakRssMB: Math.round(peak / 1e6),
    }),
  )
} finally {
  try {
    git(["worktree", "remove", "--force", tree])
  } catch {}
  fs.rmSync(work, { recursive: true, force: true })
}
