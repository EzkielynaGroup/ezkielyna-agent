// Ezkielyna Agent v0.9: prompt-assembly fingerprint. The provider's prompt cache only works while the leading bytes
// (system prompt + tool definitions) are identical between turns of one session. This module hashes exactly those
// bytes so a test (CI) and an optional runtime guard can detect an unexpected change.
import { createHash } from "node:crypto"

export interface PromptParts {
  system: readonly string[]
  tools: Record<string, { description?: string; inputSchema?: unknown; parameters?: unknown }>
}

/** Serialise in the order they are sent (order is part of the cached bytes), not sorted. */
export function promptBytes(p: PromptParts): string {
  const tools = Object.entries(p.tools).map(([name, t]) => [name, t.description ?? "", t.inputSchema ?? t.parameters ?? null])
  return JSON.stringify({ system: p.system, tools })
}

export function fingerprint(p: PromptParts): { hash: string; systemHash: string; toolsHash: string; bytes: number } {
  const h = (s: string) => createHash("sha256").update(s).digest("hex")
  const full = promptBytes(p)
  return {
    hash: h(full),
    systemHash: h(JSON.stringify(p.system)),
    toolsHash: h(full.slice(full.indexOf('"tools"'))),
    bytes: Buffer.byteLength(full),
  }
}

export interface FingerprintChange {
  sessionID: string
  turn: number
  part: "system" | "tools" | "both"
}

/** Records the fingerprint of the first turn per session and reports any later turn that differs. */
export class FingerprintGuard {
  private seen = new Map<string, { turn: number; systemHash: string; toolsHash: string }>()
  constructor(private readonly max = 256) {}

  observe(sessionID: string, p: PromptParts): FingerprintChange | undefined {
    const f = fingerprint(p)
    const prev = this.seen.get(sessionID)
    if (!prev) {
      if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value!)
      this.seen.set(sessionID, { turn: 1, systemHash: f.systemHash, toolsHash: f.toolsHash })
      return undefined
    }
    prev.turn++
    const sys = prev.systemHash !== f.systemHash
    const tools = prev.toolsHash !== f.toolsHash
    if (!sys && !tools) return undefined
    const change: FingerprintChange = { sessionID, turn: prev.turn, part: sys && tools ? "both" : sys ? "system" : "tools" }
    // keep the new baseline so one change is reported once
    prev.systemHash = f.systemHash
    prev.toolsHash = f.toolsHash
    return change
  }

  forget(sessionID: string) {
    this.seen.delete(sessionID)
  }
}

export const fingerprintGuard = new FingerprintGuard()
