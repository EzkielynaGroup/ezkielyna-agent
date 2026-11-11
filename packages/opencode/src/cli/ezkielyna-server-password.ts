import { randomBytes } from "node:crypto"
import { Flag } from "@opencode-ai/core/flag/flag"

// Ezkielyna Agent: `serve` and `web` never run an unauthenticated server. A local HTTP server without a password could be
// driven by any other program on the machine (or by a web page, through a simple cross-origin POST). When the user did not
// set EZK_SERVER_PASSWORD, a random one is generated for this run and printed once.
export function ensureServerPassword(): { password: string; username: string; generated: boolean } {
  const username = Flag.OPENCODE_SERVER_USERNAME || "ezkielyna"
  const existing = process.env["EZK_SERVER_PASSWORD"] || Flag.OPENCODE_SERVER_PASSWORD
  if (existing) return { password: existing, username, generated: false }
  const password = randomBytes(18).toString("base64url")
  process.env["EZK_SERVER_PASSWORD"] = password
  return { password, username, generated: true }
}
