// Ezkielyna Agent v3 (A10): reproduce-first rule for bug-fix prompts (Agentless / SWE-agent style).
// Sent as a reminder on the user message, never in the system prompt (cache-stable prefix).
import { classifyIntent } from "../intent/classify"

export const REPRODUCE_BLOCK = [
  "<bug_fix_protocol>",
  "This looks like a bug fix. 1) Find or write a failing reproduction (test or command) first and run it.",
  "2) Localise: file, then function, then lines; read only what you need.",
  "3) Make one minimal change; re-run the reproduction and the project verify command.",
  "</bug_fix_protocol>",
].join("\n")

/** Compatibility helper backed by the shared offline intent detector. */
export function isFixIntent(prompt: string): boolean {
  return classifyIntent(prompt) === "fix"
}
