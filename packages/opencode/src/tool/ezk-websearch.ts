// Ezkielyna Agent v3 (T5): `web_search` through the gateway. Only the query leaves the machine, and it goes to our own server,
// so the tool needs no file access and is not affected by folder trust.
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { readLocalKey } from "@opencode-ai/core/ezkielyna-localkey"
import { gatewaySearch } from "@opencode-ai/core/ezk/websearch/client"

export const ID = "web_search"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Search query, 1-400 characters" }),
  max_results: Schema.optional(Schema.Number).annotate({ description: "Number of results, 1-10 (default 5)" }),
  time_range: Schema.optional(Schema.Literals(["day", "week", "month", "year"])).annotate({
    description: "Only results from the last day, week, month or year",
  }),
  language: Schema.optional(Schema.String).annotate({ description: "Language code such as id or en" }),
})

const DESCRIPTION = `Search the web (free). Returns a short numbered list of titles, URLs and snippets. Use webfetch on a URL to read the page. If it reports a limit, stop searching and continue with what you have.`

export const EzkWebSearchTool = Tool.define(
  ID,
  Effect.sync(() => ({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        yield* ctx.metadata({ title: `Web search "${params.query}"`, metadata: {} })
        yield* ctx.ask({
          permission: ID,
          patterns: [params.query],
          always: ["*"],
          metadata: { query: params.query },
        })
        const outcome = yield* Effect.promise(() =>
          gatewaySearch({ params, key: readLocalKey(), signal: ctx.abort }),
        )
        return {
          output: outcome.ok ? outcome.output : outcome.message,
          title: `Web search: ${params.query}`,
          metadata: outcome.ok ? { count: outcome.count, cached: outcome.cached } : { error: String(outcome.status) },
        }
      }).pipe(Effect.orDie),
  })),
)
