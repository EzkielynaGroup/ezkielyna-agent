// Ezkielyna Agent v1.1: feature flags. Read from `ezkielyna.json(c)` (key `ezk`) without touching the core config
// schema (unknown keys are ignored there), plus the env kill switch EZK_FEATURES="-router,-memory,+router.log".
import fs from "node:fs"
import path from "node:path"

export interface EzkFlags {
  router: {
    enabled: boolean
    /** Claude "Auto Pro" scaffold. Deferred by the owner (D5): default false, and still capability-gated. */
    claude: boolean
    /** Optional 300 ms Flash call for ambiguous turns. */
    tiny: boolean
    /** Local-only decision log with rotation (D9). Features only, no prompt text unless logPrompts. */
    log: boolean
    logPrompts: boolean
    /** Per-session USD cap; above it turns are downgraded to Flash. 0 = off. */
    capUSD: number
    /** Optional model-policy.json URL published by the gateway owner (D1). Empty = local defaults + local file. */
    policyURL: string
  }
  memory: {
    enabled: boolean
    /** Post-turn reviewer on a Flash model. */
    review: boolean
    /** Run the reviewer every N user turns (also immediately after "remember ..." style requests). */
    reviewEvery: number
  }
  search: { enabled: boolean }
  /** Wave A "context" lane. Prompt-affecting parts are default OFF (see REPORT-WA-context.md). */
  context: {
    /** C1: user -> root..cwd -> local instruction hierarchy (AGENTS.md/CLAUDE.md, imports, rules/*.md, 32 KiB cap, trust). */
    hierarchy: boolean
    /** A9: first-turn reminder with project tree, toolchain versions and verify command. */
    session: boolean
    /** A10: reproduce-first reminder for bug-fix prompts. */
    reproduce: boolean
  }
  /** U1: /review rubric (P0-P3) on the Flash tier for the slash command. `ezkielyna review` (CLI) is always available. */
  review: { enabled: boolean }
  /** E2: `disclosure` = description budget + trust gate for project skills + per-key reviewer model. Pure fix: default ON. */
  skills: { enabled: boolean; disclosure: boolean }
  /** Wave B safety (S1): permission modes. Default OFF: today's ask-first behaviour stays until enabled. */
  modes: { enabled: boolean }
  /** Wave B safety (S2): remembered project rules, compound-aware bash matching, extended read-only list. Default OFF. */
  rules: { enabled: boolean }
  /** Wave B safety (E1): Claude-compatible hooks from settings files. Default OFF (runs user programs). */
  hooks: { enabled: boolean }
  /** Wave B safety (S4): trust banner and trusted-folder list in the desktop. Default ON (UI only, no behaviour change). */
  trust: { ui: boolean }
  // Wave B "ux" lane. All default OFF (new behaviour, not pure fixes); EZK_FEATURES="+rewind,+planApproval,+subagents,+handoff".
  /** U2: per-turn checkpoints + /rewind (files / chat / both / summarise from here). */
  rewind: { enabled: boolean; /** checkpoints offered per session (newest first) */ max: number }
  /** U3: approval card when the plan agent finishes; the approved plan is kept and re-injected after compaction. */
  planApproval: { enabled: boolean }
  /** E3: `task` registered lazily (after `minReads` read/search calls in a turn, or an @agent mention). */
  subagents: {
    enabled: boolean
    minReads: number
    /** parallel subagents per parent session */
    maxConcurrent: number
    /** provider turns of the built-in explorer */
    exploreTurns: number
    /** cap of a subagent result returned to the parent, in tokens (about 4 characters each) */
    resultTokens: number
  }
  /** C4: /handoff <goal> writes a starting prompt + file list and opens a new session prefilled with it. */
  handoff: { enabled: boolean }
  tools: {
    boundedOutput: boolean
    applyPatchEverywhere: boolean
    editRecovery: boolean
    editFixer: boolean
  }
  /** S5 `classifier`: "Otomatis-aman" model gate for safeAuto. Default OFF (spends tokens, changes approvals). */
  safety: { protectedPaths: boolean; scrubEnv: boolean; classifier: boolean }
  brand: { hygiene: boolean }
  models: { metadata: boolean; vision: boolean }
  /** T5: `web_search` tool through the gateway (offered only when a key exists). */
  websearch: { enabled: boolean }
  loop: {
    leadWorker: boolean
    phaseReasoning: boolean
    verificationGate: boolean
    verify: boolean
    plan: boolean
    guard: boolean
    resilience: boolean
    history: boolean
    /** A11: three isolated Flash attempts, verified and pruned before approval. Default OFF. */
    hard: boolean
  }
  /** v3 T6: `code_search` tool (FTS5 over paths, symbols, doc comments), also given to the Explore subagent. */
  codesearch: { enabled: boolean }
  /** v3 T7: Aider-style repo map, sent as a reminder on heavy turns in repos with more than `minFiles` files. */
  repomap: { enabled: boolean; tokens: number; minFiles: number }
  /** C2: tool-result-first compaction recipe, per-session breaker and `/compact <focus>`. Default OFF. */
  compaction: { enabled: boolean }
}

export const DEFAULT_FLAGS: EzkFlags = {
  router: { enabled: true, claude: false, tiny: false, log: false, logPrompts: false, capUSD: 1, policyURL: "https://ezkielyna.store/agent/model-policy.json" },
  memory: { enabled: true, review: true, reviewEvery: 6 },
  search: { enabled: true },
  context: { hierarchy: false, session: false, reproduce: false },
  review: { enabled: false },
  skills: { enabled: true, disclosure: true },
  modes: { enabled: false },
  rules: { enabled: false },
  hooks: { enabled: false },
  trust: { ui: true },
  rewind: { enabled: false, max: 100 },
  planApproval: { enabled: false },
  subagents: { enabled: false, minReads: 3, maxConcurrent: 3, exploreTurns: 4, resultTokens: 2000 },
  handoff: { enabled: false },
  tools: { boundedOutput: true, applyPatchEverywhere: false, editRecovery: true, editFixer: false },
  safety: { protectedPaths: true, scrubEnv: true, classifier: false },
  brand: { hygiene: true },
  // P1/P3 are published policy facts: use the real context window and only advertise image input where policy allows it.
  models: { metadata: true, vision: true },
  websearch: { enabled: true },
  // Wave A loop behavior changes turn routing and request history, so it rolls out opt-in.
  loop: {
    leadWorker: false,
    phaseReasoning: false,
    verificationGate: false,
    verify: false,
    plan: false,
    guard: false,
    resilience: false,
    history: false,
    hard: false,
  },
  codesearch: { enabled: false },
  repomap: { enabled: false, tokens: 1024, minFiles: 200 },
  compaction: { enabled: false },
}

export function stripJsonc(text: string) {
  // Windows editors (Notepad, PowerShell 5 `-Encoding UTF8`) write a byte-order mark that JSON.parse rejects.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const n = text[i + 1]
    if (inString) {
      out += c
      if (c === "\\") out += text[++i] ?? ""
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && n === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

export function readEzkConfig(dir: string): Record<string, unknown> {
  for (const file of ["ezkielyna.jsonc", "ezkielyna.json"]) {
    try {
      const parsed = JSON.parse(stripJsonc(fs.readFileSync(path.join(dir, file), "utf8"))) as Record<string, any>
      if (parsed && typeof parsed.ezk === "object" && parsed.ezk) return parsed.ezk
    } catch {}
  }
  return {}
}

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d)
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d)
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d)
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {})

/**
 * @param dirs config directories, lowest priority first (global, then project).
 * @param env  process.env (EZK_FEATURES: comma list of `-name` / `+name`, e.g. "-router,-memory,+router.log").
 */
export function loadFlags(dirs: string[], env: Record<string, string | undefined> = process.env): EzkFlags {
  const merged: Record<string, any> = {}
  for (const dir of dirs) {
    const cfg = readEzkConfig(dir)
    for (const [k, v] of Object.entries(cfg)) merged[k] = typeof v === "object" && v ? { ...obj(merged[k]), ...v } : v
  }
  const d = DEFAULT_FLAGS
  const r = obj(merged.router)
  const m = obj(merged.memory)
  const s = obj(merged.search)
  const c = obj(merged.context)
  const rv = obj(merged.review)
  const sk = obj(merged.skills)
  const section = (name: "modes" | "rules" | "hooks") => ({ enabled: bool(obj(merged[name]).enabled, d[name].enabled) })
  const rw = obj(merged.rewind)
  const sa = obj(merged.subagents)
  const int = (v: unknown, d: number) => Math.max(1, Math.floor(num(v, d)))
  const t = obj(merged.tools)
  const p = obj(merged.safety)
  const b = obj(merged.brand)
  const models = obj(merged.models)
  const w = obj(merged.websearch)
  const l = obj(merged.loop)
  const cs = obj(merged.codesearch)
  const rm = obj(merged.repomap)
  const cp = obj(merged.compaction)
  const flags: EzkFlags = {
    router: {
      enabled: bool(r.enabled, d.router.enabled),
      claude: bool(r.claude, d.router.claude),
      tiny: bool(r.tiny, d.router.tiny),
      log: bool(r.log, d.router.log),
      logPrompts: bool(r.logPrompts, d.router.logPrompts),
      capUSD: num(r.capUSD, d.router.capUSD),
      policyURL: str(r.policyURL, d.router.policyURL),
    },
    memory: {
      enabled: bool(m.enabled, d.memory.enabled),
      review: bool(m.review, d.memory.review),
      reviewEvery: Math.max(1, Math.floor(num(m.reviewEvery, d.memory.reviewEvery))),
    },
    search: { enabled: bool(s.enabled, d.search.enabled) },
    context: {
      hierarchy: bool(c.hierarchy, d.context.hierarchy),
      session: bool(c.session, d.context.session),
      reproduce: bool(c.reproduce, d.context.reproduce),
    },
    review: { enabled: bool(rv.enabled, d.review.enabled) },
    skills: { enabled: bool(sk.enabled, d.skills.enabled), disclosure: bool(sk.disclosure, d.skills.disclosure) },
    modes: section("modes"),
    rules: section("rules"),
    hooks: section("hooks"),
    trust: { ui: bool(obj(merged.trust).ui, d.trust.ui) },
    rewind: { enabled: bool(rw.enabled, d.rewind.enabled), max: int(rw.max, d.rewind.max) },
    planApproval: { enabled: bool(obj(merged.planApproval).enabled, d.planApproval.enabled) },
    subagents: {
      enabled: bool(sa.enabled, d.subagents.enabled),
      minReads: int(sa.minReads, d.subagents.minReads),
      maxConcurrent: int(sa.maxConcurrent, d.subagents.maxConcurrent),
      exploreTurns: int(sa.exploreTurns, d.subagents.exploreTurns),
      resultTokens: int(sa.resultTokens, d.subagents.resultTokens),
    },
    handoff: { enabled: bool(obj(merged.handoff).enabled, d.handoff.enabled) },
    tools: {
      boundedOutput: bool(t.boundedOutput, d.tools.boundedOutput),
      applyPatchEverywhere: bool(t.applyPatchEverywhere, d.tools.applyPatchEverywhere),
      editRecovery: bool(t.editRecovery, d.tools.editRecovery),
      editFixer: bool(t.editFixer, d.tools.editFixer),
    },
    safety: {
      protectedPaths: bool(p.protectedPaths, d.safety.protectedPaths),
      scrubEnv: bool(p.scrubEnv, d.safety.scrubEnv),
      classifier: bool(p.classifier, d.safety.classifier),
    },
    brand: { hygiene: bool(b.hygiene, d.brand.hygiene) },
    models: { metadata: bool(models.metadata, d.models.metadata), vision: bool(models.vision, d.models.vision) },
    websearch: { enabled: bool(w.enabled, d.websearch.enabled) },
    loop: {
      leadWorker: bool(l.leadWorker, d.loop.leadWorker),
      phaseReasoning: bool(l.phaseReasoning, d.loop.phaseReasoning),
      verificationGate: bool(l.verificationGate, d.loop.verificationGate),
      verify: bool(l.verify, d.loop.verify),
      plan: bool(l.plan, d.loop.plan),
      guard: bool(l.guard, d.loop.guard),
      resilience: bool(l.resilience, d.loop.resilience),
      history: bool(l.history, d.loop.history),
      hard: bool(l.hard, d.loop.hard),
    },
    codesearch: { enabled: bool(cs.enabled, d.codesearch.enabled) },
    repomap: {
      enabled: bool(rm.enabled, d.repomap.enabled),
      tokens: Math.max(256, Math.floor(num(rm.tokens, d.repomap.tokens))),
      minFiles: Math.floor(num(rm.minFiles, d.repomap.minFiles)),
    },
    compaction: { enabled: bool(cp.enabled, d.compaction.enabled) },
  }
  for (const raw of (env.EZK_FEATURES ?? "").split(",")) {
    const item = raw.trim()
    if (!item) continue
    const on = !item.startsWith("-")
    const name = item.replace(/^[+-]/, "")
    const [group, rawKey] = name.split(".")
    const key = rawKey?.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    const target = (flags as any)[group!]
    if (!target) continue
    if (key) {
      if (typeof target[key] === "boolean") target[key] = on
    } else if (typeof target.enabled === "boolean") target.enabled = on
  }
  return flags
}
