// Ezkielyna Agent Wave B T4: syntax results that ride on the existing post-edit diagnostics path.
// The LSP service calls `check(file)` after an edit when no language server covers the file, and merges
// `current()` into `lsp.diagnostics()`; edit/write/apply_patch then print them with LSP.Diagnostic.report as usual.
import fs from "node:fs"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { SyntaxDiagnostic } from "./syntax"

const MAX_FILES = 50

interface Entry {
  diags: SyntaxDiagnostic[]
  mtimeMs: number
}

export class SyntaxChecks {
  private map = new Map<string, Entry>()

  async check(file: string): Promise<SyntaxDiagnostic[] | undefined> {
    const key = FSUtil.normalizePath(file)
    const { checkSyntaxFile, installTip } = await import("./syntax")
    const diags = await checkSyntaxFile(file)
    if (!diags || diags.length === 0) {
      this.map.delete(key)
      return diags
    }
    const tip = installTip(file)
    if (tip) diags[0] = { ...diags[0]!, message: `${diags[0]!.message}\n${tip}` }
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {}
    this.map.delete(key)
    this.map.set(key, { diags, mtimeMs })
    while (this.map.size > MAX_FILES) this.map.delete(this.map.keys().next().value!)
    return diags
  }

  /** Results that are still valid: a file changed (or removed) since the check is dropped. */
  current(): [string, SyntaxDiagnostic[]][] {
    const out: [string, SyntaxDiagnostic[]][] = []
    for (const [key, entry] of this.map) {
      try {
        if (fs.statSync(key).mtimeMs !== entry.mtimeMs) throw new Error("changed")
        out.push([key, entry.diags])
      } catch {
        this.map.delete(key)
      }
    }
    return out
  }
}
