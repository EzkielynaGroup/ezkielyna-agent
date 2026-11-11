// Ezkielyna Agent v3 (Wave C, codeintel, DESIGN-V3 T7): Aider-style repo map (R3 §1.1), ported to TypeScript.
// Files are nodes; a file that references an identifier points at every file defining it, weighted by
//   multiplier x sqrt(references), where the multiplier is x10 for identifiers mentioned in the conversation, x10 for
//   long snake/camel/kebab names (>= 8 chars), x0.1 for `_private` names, x0.1 for names defined in more than 5 files,
//   and x50 when the referencing file is one the conversation touched. Names defined in more than 20 files are skipped.
// PageRank is personalised towards the touched/mentioned files; each file's rank is spread over the definitions its
// edges point at, and the best definitions are packed into a token budget by binary search (accepting within 15%).
import type { DefKind } from "./tags"
import type { GraphRows } from "./index"

export const DEFAULT_MAP_TOKENS = 1024
const DAMPING = 0.85
const ITERATIONS = 30
const TOLERANCE = 1e-8
const MAX_DEFINERS = 20

export interface RepoMapInput {
  graph: GraphRows
  /** relative paths the conversation mentions or touched */
  chatFiles?: Iterable<string>
  /** identifiers mentioned in the conversation */
  mentionedIdents?: Iterable<string>
  maxTokens?: number
}

export interface RepoMap {
  text: string
  tokens: number
  files: string[]
  definitions: number
}

interface RankedDef {
  file: string
  name: string
  line: number
  kind: DefKind
  signature: string
  rank: number
}

/** ~4 characters per token, the same estimate the rest of the agent uses for budgets. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

export function buildRepoMap(input: RepoMapInput): RepoMap {
  const budget = input.maxTokens ?? DEFAULT_MAP_TOKENS
  // A definition line is at least ~6 characters, so more than budget*4/6 of them can never fit.
  const ranked = rankDefinitions(input, Math.ceil((budget * 4) / 6))
  // Binary search on the number of definitions; keep the largest map within budget (or within 15% below it).
  let lo = 0
  let hi = ranked.length
  let best: RepoMap = { text: "", tokens: 0, files: [], definitions: 0 }
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const map = render(ranked.slice(0, mid))
    if (map.tokens <= budget) {
      if (map.tokens > best.tokens) best = map
      if (map.tokens >= budget * 0.85) break
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

/** The `limit` best definitions (all when omitted), best first. Only those are materialised as objects. */
export function rankDefinitions(input: RepoMapInput, limit = Infinity): RankedDef[] {
  // Intern files and identifiers; big repos have hundreds of thousands of rows, so edges live in flat arrays.
  const fileIds = new Map<string, number>()
  const fid = (file: string) => fileIds.get(file) ?? (fileIds.set(file, fileIds.size), fileIds.size - 1)
  const nameIds = new Map<string, number>()
  const definers: Set<number>[] = []
  for (const def of input.graph.defs) {
    let n = nameIds.get(def.name)
    if (n === undefined) nameIds.set(def.name, (n = nameIds.size))
    ;(definers[n] ??= new Set()).add(fid(def.file))
  }
  const referencers: Map<number, number>[] = []
  for (const ref of input.graph.refs) {
    const n = nameIds.get(ref.name)
    if (n === undefined) continue
    const files = (referencers[n] ??= new Map())
    const f = fid(ref.file)
    files.set(f, (files.get(f) ?? 0) + ref.n)
  }
  const chat = new Set([...(input.chatFiles ?? [])].flatMap((f) => (fileIds.has(f) ? [fileIds.get(f)!] : [])))
  const mentioned = new Set(input.mentionedIdents ?? [])
  const names = [...nameIds.keys()]

  const src: number[] = []
  const dst: number[] = []
  const via: number[] = []
  const weight: number[] = []
  // Aider gives unreferenced definitions a 0.1 self edge; on small or loosely connected graphs that self loop keeps
  // all of an isolated file's rank. Here they get a tenth of their file's rank instead, so they only fill leftover space.
  const unreferenced = new Map<number, number[]>()
  for (const [n, files] of definers.entries()) {
    const refs = referencers[n]
    if (!refs) {
      for (const f of files) unreferenced.set(f, [...(unreferenced.get(f) ?? []), n])
      continue
    }
    // Generic names (`String`, `New`, `get`) defined all over the repo say little about structure and would multiply
    // the edge count by the number of definers; Aider already weights them x0.1, here they are left out.
    if (files.size > MAX_DEFINERS) continue
    const mul = multiplier(names[n]!, mentioned, files.size)
    for (const [from, count] of refs) {
      const w = mul * Math.sqrt(count) * (chat.has(from) ? 50 : 1)
      for (const to of files) {
        src.push(from)
        dst.push(to)
        via.push(n)
        weight.push(w)
      }
    }
  }

  const nodes = fileIds.size
  let personal: Float64Array | undefined
  if (chat.size) {
    personal = new Float64Array(nodes)
    for (const f of chat) personal[f] = 1 / chat.size
  }
  const rank = pagerank(nodes, src, dst, weight, personal)

  const total = new Float64Array(nodes)
  for (let e = 0; e < src.length; e++) total[src[e]!]! += weight[e]!
  const width = names.length
  const scores = new Map<number, number>()
  for (let e = 0; e < src.length; e++) {
    const key = dst[e]! * width + via[e]!
    scores.set(key, (scores.get(key) ?? 0) + (rank[src[e]!]! * weight[e]!) / total[src[e]!]!)
  }
  for (const [f, list] of unreferenced) {
    const share = (rank[f]! * 0.1) / list.length
    for (const n of list) scores.set(f * width + n, (scores.get(f * width + n) ?? 0) + share)
  }

  const top = [...scores].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1])
  const keep = new Map(top.slice(0, Number.isFinite(limit) ? Math.max(limit, 0) * 2 : top.length))
  const out: RankedDef[] = []
  for (const def of input.graph.defs) {
    const score = keep.get(fileIds.get(def.file)! * width + nameIds.get(def.name)!)
    if (score !== undefined) out.push({ ...def, rank: score })
  }
  return out.sort((a, b) => b.rank - a.rank || a.file.localeCompare(b.file) || a.line - b.line).slice(0, limit)
}

function multiplier(name: string, mentioned: Set<string>, definedIn: number) {
  let mul = 1
  if (mentioned.has(name)) mul *= 10
  const long = name.length >= 8 && (/[a-z][A-Z]/.test(name) || name.includes("_") || name.includes("-"))
  if (long) mul *= 10
  if (name.startsWith("_")) mul *= 0.1
  if (definedIn > 5) mul *= 0.1
  return mul
}

/**
 * Weighted, personalised PageRank (power iteration) over `n` nodes and parallel edge arrays.
 * Dangling nodes redistribute along the personalisation vector (uniform when there is none).
 */
export function pagerank(n: number, src: ArrayLike<number>, dst: ArrayLike<number>, weight: ArrayLike<number>, personal?: Float64Array) {
  if (!n) return new Float64Array(0)
  const p = personal ?? new Float64Array(n).fill(1 / n)
  const total = new Float64Array(n)
  for (let e = 0; e < src.length; e++) total[src[e]!]! += weight[e]!
  let rank = new Float64Array(n).fill(1 / n)
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Float64Array(n)
    for (let e = 0; e < src.length; e++) next[dst[e]!]! += (DAMPING * rank[src[e]!]! * weight[e]!) / total[src[e]!]!
    let dangling = 0
    for (let i = 0; i < n; i++) if (!total[i]) dangling += rank[i]!
    let delta = 0
    for (let i = 0; i < n; i++) {
      next[i]! += (DAMPING * dangling + (1 - DAMPING)) * p[i]!
      delta += Math.abs(next[i]! - rank[i]!)
    }
    rank = next
    if (delta < TOLERANCE * n) break
  }
  return rank
}

/** `path:` then the chosen signatures, files in rank order, definitions in line order. */
export function render(defs: RankedDef[]): RepoMap {
  const byFile = new Map<string, RankedDef[]>()
  for (const def of defs) {
    const list = byFile.get(def.file)
    if (list) list.push(def)
    else byFile.set(def.file, [def])
  }
  const blocks = [...byFile].map(([file, list]) => {
    const lines = [...new Map(list.sort((a, b) => a.line - b.line).map((d) => [d.line, d])).values()].map((d) => `  ${d.line}: ${d.signature || d.name}`)
    return `${file}:\n${lines.join("\n")}`
  })
  const text = blocks.join("\n")
  return { text, tokens: estimateTokens(text), files: [...byFile.keys()], definitions: defs.length }
}

/** Repo-relative files named in free text (exact relative path or a unique basename). */
export function mentionedFiles(text: string, files: Iterable<string>) {
  const words = new Set(text.match(/[\w./-]+/g) ?? [])
  const byBase = new Map<string, string[]>()
  const out = new Set<string>()
  for (const file of files) {
    if (words.has(file) || words.has(`./${file}`)) out.add(file)
    const base = file.slice(file.lastIndexOf("/") + 1)
    const list = byBase.get(base)
    if (list) list.push(file)
    else byBase.set(base, [file])
  }
  for (const word of words) {
    const list = byBase.get(word)
    if (list?.length === 1 && word.includes(".")) out.add(list[0]!)
  }
  return out
}

/** Identifier-looking words in free text (used for the x10 "mentioned" multiplier). */
export function mentionedIdentifiers(text: string) {
  return new Set((text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter((w) => /[A-Z_]/.test(w.slice(1)) || w.length >= 4))
}
