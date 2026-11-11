import type { Argv } from "yargs"
import { Effect } from "effect"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { detectLang } from "@opencode-ai/core/ezkielyna-errors"
import { execEnabled } from "@opencode-ai/core/ezk/exec/flags"
import { effectCmd, fail } from "@/cli/effect-cmd"
import { buildBugReport, reportDependencies } from "./bugreport"
import { saveBugReport } from "./bugreport-file"

export function reportInstructions(language: "en" | "id", groupUrl = EZK.supportGroupUrl) {
  return language === "id"
    ? `Kirim file ini ke grup diskusi WhatsApp Ezkielyna (${groupUrl}) atau balas email undangan. Jangan kirim API key.`
    : `Send this file to the Ezkielyna WhatsApp discussion group (${groupUrl}) or reply to the invitation email. Do not send your API key.`
}

export const BugReportCommand = effectCmd({
  command: "lapor",
  aliases: ["bug-report"],
  describe: "create a redacted report for beta support",
  instance: false,
  builder: (yargs: Argv) => yargs.option("out", { type: "string", describe: "save the report to this file path" }),
  handler: Effect.fn("Cli.bugReport")(function* (args) {
    if (!execEnabled("diagnostics")) return yield* fail("`lapor` is turned off (EZK_FEATURES has -diagnostics).")
    const language = detectLang()
    const report = yield* Effect.promise(() => buildBugReport(reportDependencies(language)))
    const target = yield* Effect.promise(() => saveBugReport({ report, cwd: process.cwd(), out: args.out }))
    process.stdout.write(`${target}\n${reportInstructions(language)}\n`)
  }),
})
