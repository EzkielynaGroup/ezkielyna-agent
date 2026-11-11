// Ezkielyna Agent v1.1: one-step erase of everything the ezk features stored locally.
// `ezkielyna memory wipe` and the Desktop "Erase memory" button both call this. Additive data only, so sessions are untouched.
import fs from "node:fs"
import path from "node:path"
import { MemoryStore } from "./memory/store"

export function ezkPaths(dirs: { config: string; data: string }, env: Record<string, string | undefined> = process.env) {
  const memoryDir = env.EZK_MEMORY_DIR?.trim() ? path.resolve(env.EZK_MEMORY_DIR) : path.join(dirs.config, "memory")
  const profile = env.EZK_PROFILE?.trim()
  const profileName = profile ? (/^[A-Za-z0-9._-]{1,64}$/.test(profile) ? profile : "custom") : undefined
  const ezkDataDir = path.join(dirs.data, "ezk", ...(profileName ? [profileName] : []))
  return {
    memoryDir,
    ezkDataDir,
    searchDb: path.join(ezkDataDir, "search.db"),
  }
}

export interface WipeReport {
  memoryFiles: number
  searchIndex: boolean
  routerData: boolean
}

export function wipeMemory(
  dirs: { config: string; data: string },
  opts: { includeRouter?: boolean } = {},
  env: Record<string, string | undefined> = process.env,
): WipeReport {
  const p = ezkPaths(dirs, env)
  const memoryFiles = new MemoryStore(p.memoryDir).wipe()
  let searchIndex = false
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      fs.rmSync(p.searchDb + suffix)
      if (suffix === "") searchIndex = true
    } catch {}
  }
  let routerData = false
  if (opts.includeRouter) {
    try {
      for (const f of fs.readdirSync(p.ezkDataDir)) {
        fs.rmSync(path.join(p.ezkDataDir, f), { force: true, recursive: true })
        routerData = true
      }
    } catch {}
  }
  try {
    fs.rmdirSync(p.ezkDataDir)
  } catch {}
  return { memoryFiles, searchIndex, routerData }
}
