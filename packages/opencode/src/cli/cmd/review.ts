import { Global } from "@opencode-ai/core/global"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { listModels } from "@opencode-ai/core/ezkielyna"
import { readGatewayKey } from "@opencode-ai/core/ezk/key"
import { PriceBook } from "@opencode-ai/core/ezk/pricing"
import { reviewerModelFor } from "@opencode-ai/core/ezk/skills/disclosure"
import { buildReviewPrompt, collectDiff, formatFindings, parseFindings, parseTarget } from "@opencode-ai/core/ezk/review"
import { UI } from "../ui"
import { cmd } from "./cmd"

// `ezkielyna review [instructions]`: one non-streaming call on the cheapest Flash-class model the key can use.
// Targets: uncommitted changes (default), --base BRANCH, --commit SHA, or free text as custom instructions.
// Reads only the git diff (capped at ~600 lines); never edits files and never prints the API key.
export const ReviewCommand = cmd<{}, { prompt?: string[]; base?: string; commit?: string; uncommitted?: boolean }>({
  command: "review [prompt..]",
  describe: "review code changes with the P0-P3 rubric (uncommitted by default)",
  builder: (yargs) =>
    yargs
      .positional("prompt", { type: "string", array: true, describe: "custom review instructions" })
      .option("base", { type: "string", describe: "review changes against this base branch" })
      .option("commit", { type: "string", describe: "review one commit" })
      .option("uncommitted", { type: "boolean", describe: "review staged, unstaged and untracked changes (default)" }) as any,
  handler: async (args) => {
    try {
      const target = parseTarget({ base: args.base, commit: args.commit, prompt: args.prompt?.join(" ") })
      const diff = await collectDiff(target, process.cwd())
      if (diff.empty) {
        UI.println("Nothing to review.")
        return
      }
      const key = readGatewayKey(Global.Path.data)
      if (!key) {
        UI.println("No API key found. Run `ezkielyna providers login` first.")
        process.exitCode = 1
        return
      }
      const { ids } = await listModels({ key, baseURL: EZK.baseURL, cacheDir: Global.Path.cache })
      const prices = new PriceBook()
      const model = reviewerModelFor(ids, { price: (id) => prices.get(id) })
      if (!model) {
        UI.println("No light model is available for this key.")
        process.exitCode = 1
        return
      }
      const prompt = buildReviewPrompt({ diff: diff.text, target })
      const res = await fetch(`${EZK.baseURL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 1500,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`The review request failed (HTTP ${res.status}).`)
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const text = body.choices?.[0]?.message?.content ?? ""
      if (diff.truncated) UI.println(`(diff cut to the first 600 of ${diff.totalLines} lines)`)
      UI.println(formatFindings(parseFindings(text)))
    } catch (err) {
      UI.println(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
  },
})
