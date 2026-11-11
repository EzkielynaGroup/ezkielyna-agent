// BM25 over tool names and one-line descriptions (pure). Small corpora (tens to hundreds of tools), so no index cache.
export interface Doc {
  id: string
  name: string
  description?: string
}

const K1 = 1.2
const B = 0.75

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem)
}

function stem(w: string) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y"
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1)
  return w
}

export function bm25(docs: Doc[], query: string, limit = 5): { id: string; score: number }[] {
  const q = [...new Set(tokenize(query))]
  if (q.length === 0 || docs.length === 0) return []
  // The name counts three times: a tool called "create_issue" should beat one that merely mentions issues.
  const toks = docs.map((d) => [...tokenize(d.name), ...tokenize(d.name), ...tokenize(d.name), ...tokenize(d.description ?? "")])
  const avg = toks.reduce((n, t) => n + t.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1)
  const scored = docs.map((d, i) => {
    const t = toks[i]!
    const tf = new Map<string, number>()
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1)
    let score = 0
    for (const w of q) {
      const f = tf.get(w) ?? 0
      if (!f) continue
      const n = df.get(w) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * t.length) / avg))
    }
    return { id: d.id, score }
  })
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
}
