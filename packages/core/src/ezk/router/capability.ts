// Ezkielyna Agent v1.1: "Auto Pro" (Claude routing) capability check. SCAFFOLD ONLY, hidden (owner decision D5).
//
// The picker entry only appears when ALL hold: flag ezk.router.claude is true, the key's /v1/models lists a pro model,
// a 1-token probe succeeded in the last 24 h, and that model's breaker is closed. Any 401/402/403/404 disables it for
// 30 min through the normal breaker, so unavailable pro models disappear from the picker.
// Nothing in v1.1 calls `probe()` automatically and the flag defaults to false, so users never see it.
import type { ModelPolicy } from "../model-policy"
import type { RouterEngine } from "./engine"

export const PROBE_TTL_MS = 24 * 3600_000

export class ProCapability {
  private probes = new Map<string, { at: number; ok: boolean }>()
  constructor(
    private engine: RouterEngine,
    private flag: () => boolean,
    private now: () => number = Date.now,
  ) {}

  private models(policy: ModelPolicy) {
    return [...policy.chains.proHeavy, ...policy.chains.proLight].filter((m) => m.startsWith("claude-"))
  }

  record(model: string, ok: boolean) {
    this.probes.set(model, { at: this.now(), ok })
    if (ok) this.engine.breaker.success(model)
  }

  visible(): boolean {
    if (!this.flag()) return false
    for (const m of this.models(this.engine.policy)) {
      const p = this.probes.get(m)
      if (this.engine.allowed.ids.has(m) && p?.ok && this.now() - p.at < PROBE_TTL_MS && !this.engine.breaker.isOpen(m)) return true
    }
    return false
  }

  /** 1-token chat call; the caller supplies the transport (never invoked in v1.1 by default). */
  async probe(model: string, call: (model: string) => Promise<number>) {
    try {
      const status = await call(model)
      const ok = status >= 200 && status < 300
      this.record(model, ok)
      if (!ok) this.engine.breaker.failure(model, status)
      return ok
    } catch {
      this.record(model, false)
      this.engine.breaker.failure(model, 0)
      return false
    }
  }
}
