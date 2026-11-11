// Ezkielyna Agent v3 (Wave C, codeintel): the project's file list, respecting .gitignore.
// Inside a git work tree `git ls-files` answers (tracked + untracked-but-not-ignored, the same set ripgrep searches);
// elsewhere, and in projects the user has not trusted, a bounded walk applies the root .gitignore plus the usual
// dependency/build folders. A repo's own `.git/config` can make git run commands (core.fsmonitor and friends), which
// is why untrusted projects never start a git process here and HEAD is read from the files.
import { execFile } from "node:child_process"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import ignore from "ignore"

export const MAX_FILES = 200_000
const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", "target", "out", ".next", ".venv", "venv", "__pycache__", ".cache"])

export interface FileList {
  files: string[]
  /** "git" when git listed the files (repo maps are offered only there), "walk" otherwise */
  source: "git" | "walk"
  truncated: boolean
}

/** Relative paths (forward slashes), sorted, capped at `max`. `useGit: false` (untrusted project) always walks. */
export async function listProjectFiles(root: string, max = MAX_FILES, useGit = true): Promise<FileList> {
  const git = useGit ? await gitFiles(root).catch(() => undefined) : undefined
  if (git) {
    const files = [...new Set(git)].sort()
    return { files: files.slice(0, max), source: "git", truncated: files.length > max }
  }
  return walk(root, max)
}

/** The commit HEAD points at, read from the `.git` files (no git process). Undefined outside git or before a commit. */
export function gitHead(root: string): string | undefined {
  const gitDir = resolveGitDir(root)
  if (!gitDir) return undefined
  const head = readText(path.join(gitDir, "HEAD"))?.trim()
  if (!head) return undefined
  if (!head.startsWith("ref: ")) return /^[0-9a-f]{40,64}$/.test(head) ? head : undefined
  const ref = head.slice("ref: ".length).trim()
  // Linked worktrees keep their own HEAD but share refs with the main repository (`commondir`).
  const commonDir = readText(path.join(gitDir, "commondir"))?.trim()
  const common = commonDir ? path.resolve(gitDir, commonDir) : gitDir
  for (const dir of [gitDir, common]) {
    const sha = readText(path.join(dir, ref))?.trim()
    if (sha) return sha
  }
  return readText(path.join(common, "packed-refs"))
    ?.split(/\r?\n/)
    .find((line) => line.endsWith(` ${ref}`))
    ?.split(" ")[0]
}

function resolveGitDir(root: string) {
  const dotGit = path.join(root, ".git")
  const st = fsSync.statSync(dotGit, { throwIfNoEntry: false })
  if (!st) return undefined
  if (st.isDirectory()) return dotGit
  const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "")
  return pointer ? path.resolve(root, pointer[1]!.trim()) : undefined
}

function readText(file: string) {
  try {
    return fsSync.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

async function gitFiles(root: string) {
  const out = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)
  // Deleted-but-tracked files still show in --cached; the indexer stats every path and drops the missing ones.
  return out.split("\0").filter(Boolean)
}

function run(cmd: string, args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    )
  })
}

async function walk(root: string, max: number): Promise<FileList> {
  const ig = ignore()
  const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8").catch(() => "")
  if (gitignore) ig.add(gitignore)
  const files: string[] = []
  const queue = [""]
  while (queue.length && files.length <= max) {
    const dir = queue.shift()!
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || ig.ignores(`${rel}/`)) continue
        queue.push(rel)
        continue
      }
      if (entry.isFile() && !ig.ignores(rel)) files.push(rel)
    }
  }
  files.sort()
  return { files: files.slice(0, max), source: "walk", truncated: files.length > max }
}
