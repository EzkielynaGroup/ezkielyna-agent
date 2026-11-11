import { AGENTS, type Agent } from "./agent-args"

export type PassPair = { aPass: boolean; bPass: boolean }

/** Two-sided exact paired sign test for the pass/fail outcome; ties are omitted. */
export function pairedSignTest(pairs: PassPair[]) {
  let aWins = 0
  let bWins = 0
  let ties = 0
  for (const pair of pairs) {
    if (pair.aPass === pair.bPass) ties++
    else if (pair.aPass) aWins++
    else bWins++
  }
  const n = aWins + bWins
  const tail = n === 0 ? 0.5 : binomialTail(n, Math.min(aWins, bWins))
  return { aWins, bWins, ties, n, pValue: Math.min(1, 2 * tail), tooSmall: n < 10 }
}

function binomialTail(n: number, max: number) {
  let term = 2 ** -n
  let total = term
  for (let k = 1; k <= max; k++) {
    term *= (n - k + 1) / k
    total += term
  }
  return total
}

export type Arm = { name: "A" | "B"; agent: Agent; features: string; model?: string }

/**
 * One arm of an A/B run. Whitespace-separated settings: `agent=ezkielyna|upstream`, `model=<id>` (overrides --model for
 * this arm), `EZK_FEATURES=<list>`; a bare value is the feature list (the original syntax: `--a '-router'`).
 * Examples: `EZK_FEATURES=-router`, `agent=upstream`, `agent=ezkielyna EZK_FEATURES=+mcp-defer`.
 */
export function parseArm(value: string, name: Arm["name"]): Arm {
  const arm: Arm = { name, agent: "ezkielyna", features: "" }
  for (const token of value.trim().split(/\s+/).filter(Boolean)) {
    const match = /^(agent|model|EZK_FEATURES)=(.*)$/.exec(token)
    if (!match) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) throw new Error(`unknown setting "${token}" in --${name.toLowerCase()}; use agent=, model= or EZK_FEATURES=`)
      arm.features = token
      continue
    }
    if (match[1] === "EZK_FEATURES") arm.features = match[2]!
    if (match[1] === "model") arm.model = match[2]!
    if (match[1] === "agent") {
      if (!AGENTS.includes(match[2] as Agent)) throw new Error(`agent must be one of ${AGENTS.join(", ")}, got "${match[2]}"`)
      arm.agent = match[2] as Agent
    }
  }
  if (arm.agent === "upstream" && arm.features) throw new Error(`arm ${name}: EZK_FEATURES has no effect on upstream OpenCode`)
  return arm
}

/** How the arm is shown in AB.md. */
export function armLabel(arm: Arm) {
  return [
    arm.agent === "upstream" ? "agent=upstream" : undefined,
    arm.model ? `model=${arm.model}` : undefined,
    arm.agent === "ezkielyna" ? `EZK_FEATURES=${arm.features || "(defaults)"}` : undefined,
  ]
    .filter(Boolean)
    .join(" ")
}
