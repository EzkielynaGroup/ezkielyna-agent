import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { bugReportFilename } from "@opencode-ai/core/ezk/diag/report-file"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"

export type BugReportTransport = { fetch?: typeof fetch; url?: string; headers?: HeadersInit; directory?: string }

export async function fetchBugReport(transport: BugReportTransport, model?: string) {
  const query = model ? `?model=${encodeURIComponent(model)}` : ""
  const url = transport.url?.replace(/\/+$/, "")
  if (!url) throw new Error("Local server URL is unavailable")
  const response = await (transport.fetch ?? fetch)(`${url}/ezk/bugreport${query}`, {
    method: "GET",
    headers: transport.headers,
  })
  const body = (await response.json().catch(() => ({}))) as { enabled?: boolean; report?: string; error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  if (!body.enabled || typeof body.report !== "string") throw new Error("Bug report is turned off or unavailable")
  return body.report
}

export async function saveTuiBugReport(report: string, directory = process.cwd(), now = new Date()) {
  const target = path.join(directory, bugReportFilename(now))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, report, { encoding: "utf8", mode: 0o600 })
  return target
}

export function createBugReportCommand(deps: {
  language: "en" | "id"
  request: () => Promise<string>
  save: (report: string) => Promise<string>
  toast: { show: (input: { title?: string; message: string; variant: "success" | "warning" }) => void }
  groupUrl?: string
}) {
  const id = deps.language === "id"
  return {
    title: id ? "Laporkan masalah" : "Report a problem",
    value: "ezk.bugreport",
    category: id ? "Bantuan" : "Help",
    slash: { name: "lapor" },
    run: async () => {
      try {
        const report = await deps.request()
        const file = await deps.save(report)
        const instructions = id
          ? `Kirim file ini ke grup diskusi WhatsApp Ezkielyna (${deps.groupUrl ?? EZK.supportGroupUrl}) atau balas email undangan. Jangan kirim API key.`
          : `Send this file to the Ezkielyna WhatsApp discussion group (${deps.groupUrl ?? EZK.supportGroupUrl}) or reply to the invitation email. Do not send your API key.`
        deps.toast.show({ title: file, message: instructions, variant: "success" })
      } catch {
        deps.toast.show({ message: id ? "Gagal membuat laporan masalah." : "Could not create the bug report.", variant: "warning" })
      }
    },
  }
}
