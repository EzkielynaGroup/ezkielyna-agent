// Ezkielyna Agent: does this process have any Ezkielyna credential? The provider sets it when it resolves the key
// (auth.json, ezkielyna.json options.apiKey or EZKIELYNA_API_KEY); until then, and as a second opinion, auth.json/env are read.
// Used to tell "no key yet" from "the key was refused" when the gateway answers 401 (provider/error.ts).
import { hasLocalCredential } from "@opencode-ai/core/ezkielyna-localkey"

let known: boolean | undefined

export function setEzkKeyPresent(present: boolean) {
  known = present
}

export function ezkKeyPresent(): boolean {
  return known === true || hasLocalCredential()
}

/** test hook */
export function resetEzkKeyState() {
  known = undefined
}
