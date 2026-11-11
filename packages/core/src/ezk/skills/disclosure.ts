// Ezkielyna Agent v3 (E2): progressive disclosure for skills + reviewer model chosen from the key's own light chain.
//   - the prompt carries only name + one-line description (each <= 1,536 chars, total <= 8,000 chars); the body is
//     loaded by the `skill` tool on use.
//   - the post-task reviewer runs on the cheapest model of the light chain that THIS key can use (Flash/Luna keys
//     included), instead of the hard-coded `default-model` alias that Flash-only keys do not have.
import { DEFAULT_POLICY, type ModelPolicy, cheapestFor, allowedFrom } from "../model-policy"
import { type Price, perMtok } from "../pricing"

export const SKILL_DESCRIPTION_MAX = 1536
export const SKILL_LIST_BUDGET = 8000
const MIN_DESCRIPTION = 40
const ENTRY_OVERHEAD = 100 // the <skill>/<name>/<description>/<location> tags and newlines of one entry

export interface SkillLine {
  name: string
  description?: string
  /** Extra characters this entry costs in the prompt besides name + description (e.g. a location line). */
  extra?: number
}

export const oneLine = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim()

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`)

export interface Budgeted {
  entries: { name: string; description: string; extra: number }[]
  /** Skills dropped because even minimal descriptions did not fit the budget. */
  omitted: number
  shortened: boolean
}

export function budgetSkills(list: SkillLine[], opts: { perSkill?: number; total?: number } = {}): Budgeted {
  const perSkill = opts.perSkill ?? SKILL_DESCRIPTION_MAX
  const total = opts.total ?? SKILL_LIST_BUDGET
  const base = list
    .filter((s) => oneLine(s.description))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({ name: s.name, description: clip(oneLine(s.description), perSkill), extra: s.extra ?? 0 }))
  const cost = (items: { name: string; description: string; extra: number }[], cap: number) =>
    items.reduce((n, s) => n + s.name.length + Math.min(s.description.length, cap) + ENTRY_OVERHEAD + s.extra, 0)
  if (cost(base, perSkill) <= total) return { entries: base, omitted: 0, shortened: base.some((s, i) => s.description !== oneLine(list.find((x) => x.name === s.name)?.description)) }

  // shrink every description to a common cap (largest cap that fits), then drop the tail if needed
  let items = base
  let omitted = 0
  while (items.length && cost(items, MIN_DESCRIPTION) > total) {
    items = items.slice(0, -1)
    omitted++
  }
  let lo = MIN_DESCRIPTION
  let hi = perSkill
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (cost(items, mid) <= total) lo = mid
    else hi = mid - 1
  }
  return { entries: items.map((s) => ({ ...s, description: clip(s.description, lo) })), omitted, shortened: true }
}

/**
 * Cheapest usable reviewer model for THIS key. `ids` = model ids the key can call (from the gateway model list).
 * Order: cheapest price among light-chain models the key has; else the policy's flash list; else a gateway alias;
 * else undefined (caller must skip the review and say so, never fall back to a model the key lacks).
 */
export function reviewerModelFor(
  ids: Iterable<string>,
  opts: { policy?: ModelPolicy; price?: (id: string) => Price | undefined } = {},
): string | undefined {
  const policy = opts.policy ?? DEFAULT_POLICY
  const set = new Set(ids)
  if (!set.size) return undefined
  const candidates = [...new Set([...policy.chains.light, ...policy.flash, ...policy.review])].filter((id) => set.has(id))
  if (candidates.length) {
    const cost = (id: string) => {
      const p = opts.price?.(id)
      return p ? perMtok(p).input + perMtok(p).output : Number.POSITIVE_INFINITY
    }
    // stable: policy order breaks ties, a known price beats an unknown one
    return candidates.map((id, i) => ({ id, i, c: cost(id) })).toSorted((a, b) => a.c - b.c || a.i - b.i)[0]!.id
  }
  return cheapestFor(policy, allowedFrom(set, policy))
}
