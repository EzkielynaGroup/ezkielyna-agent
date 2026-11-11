// Privacy gate (static): memory and search code has no network access of its own. The only place memory content can
// leave the machine is the reviewer call (and the normal chat request) to the gateway the user configured.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../src/ezk")
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))

describe("egress", () => {
  for (const sub of ["memory", "search"]) {
    test(`core/ezk/${sub} has no network primitives`, () => {
      for (const file of walk(path.join(root, sub))) {
        const src = fs.readFileSync(file, "utf8")
        expect(src, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(http|https|net|tls|dgram)|\bnew URL\(|https?:\/\//)
      }
    })
  }
  test("router/pricing/policy only talk to the gateway origin or a configured policyURL (no hard-coded third-party hosts)", () => {
    const hosts = new Set<string>()
    for (const file of walk(root)) for (const m of fs.readFileSync(file, "utf8").matchAll(/https?:\/\/[^\s"'`)]+/g)) hosts.add(m[0])
    // only doc comments / examples may contain URLs; none may be a real third-party host
    for (const h of hosts) expect(h).toMatch(/^https?:\/\/(example|gw\.test|x\b|127\.0\.0\.1|localhost|api\.ezkielyna\.store|ezkielyna\.store|api\.telegram\.org)/)
  })
})
