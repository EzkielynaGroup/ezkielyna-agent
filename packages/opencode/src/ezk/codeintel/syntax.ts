// Ezkielyna Agent Wave B T4(b): tree-sitter syntax check used after edits when no language server is attached.
//   - Grammars come from the ONE shared loader (core/src/ezk/treesitter/loader.ts, also used by code_search / the repo map):
//     lazy, one grammar at a time, TS/TSX/JS, Python, Go, Rust, Java, JSON and YAML.
//   - Output is a list of LSP-shaped diagnostics (severity 1) so the existing post-edit report can print them.
//   - A missing grammar file, an oversized file or any internal failure yields "no result", never an error.
import fs from "node:fs"
import path from "node:path"
import { grammarFor, withTree, type GrammarID } from "@opencode-ai/core/ezk/treesitter/loader"

export type SyntaxLang = GrammarID

/** Grammar for a file name (declaration files are skipped), or undefined when none ships. */
export function syntaxLangFor(file: string): SyntaxLang | undefined {
  return grammarFor(file)
}

export const MAX_SYNTAX_BYTES = 512 * 1024
export const MAX_ISSUES = 5

export interface SyntaxIssue {
  /** 0-based */
  line: number
  character: number
  endLine: number
  endCharacter: number
  kind: "error" | "missing"
  /** For `missing` nodes: the token tree-sitter expected. */
  expected?: string
}

export interface SyntaxDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity: 1
  source: "tree-sitter"
  message: string
}

/** One line plus one line of context on each side (2 lines of context), numbered, with `>` on the error line. */
export function contextSnippet(text: string, line: number): string {
  const lines = text.split(/\r?\n/)
  const from = Math.max(0, line - 1)
  const to = Math.min(lines.length - 1, line + 1)
  const width = String(to + 1).length
  const out: string[] = []
  for (let i = from; i <= to; i++) {
    const body = lines[i]!.length > 160 ? lines[i]!.slice(0, 160) + "…" : lines[i]!
    out.push(`${i === line ? ">" : " "} ${String(i + 1).padStart(width)} | ${body}`)
  }
  return out.join("\n")
}

export function toDiagnostics(text: string, issues: SyntaxIssue[]): SyntaxDiagnostic[] {
  return issues.map((i) => ({
    range: { start: { line: i.line, character: i.character }, end: { line: i.endLine, character: i.endCharacter } },
    severity: 1 as const,
    source: "tree-sitter" as const,
    message: `${i.kind === "missing" ? `Syntax error: missing ${i.expected ?? "token"}` : "Syntax error: unexpected code here"}\n${contextSnippet(text, i.line)}`,
  }))
}

/** Collect up to `max` innermost ERROR / MISSING nodes, in document order. */
export function collectIssues(root: any, max = MAX_ISSUES): SyntaxIssue[] {
  const issues: SyntaxIssue[] = []
  if (!root?.hasError) return issues
  const walk = (node: any) => {
    if (issues.length >= max) return
    if (node.isMissing) {
      issues.push({
        line: node.startPosition.row,
        character: node.startPosition.column,
        endLine: node.endPosition.row,
        endCharacter: node.endPosition.column,
        kind: "missing",
        expected: node.type ? `\`${node.type}\`` : undefined,
      })
      return
    }
    let descended = false
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child && child.hasError) {
        walk(child)
        descended = true
      }
    }
    // An ERROR node whose children are clean is the innermost spot; report the node itself.
    if (!descended && (node.isError || node.hasError)) {
      issues.push({
        line: node.startPosition.row,
        character: node.startPosition.column,
        endLine: node.endPosition.row,
        endCharacter: node.endPosition.column,
        kind: "error",
      })
    }
  }
  walk(root)
  return issues
}

/** Parse text and return diagnostics. `undefined` = not checked (unsupported, too big, grammar not available). */
export async function checkSyntaxText(file: string, text: string): Promise<SyntaxDiagnostic[] | undefined> {
  const lang = syntaxLangFor(file)
  if (!lang) return undefined
  if (Buffer.byteLength(text) > MAX_SYNTAX_BYTES) return undefined
  try {
    return await withTree(lang, text, (tree) => toDiagnostics(text, collectIssues(tree.rootNode)))
  } catch {
    return undefined
  }
}

export async function checkSyntaxFile(file: string): Promise<SyntaxDiagnostic[] | undefined> {
  if (!syntaxLangFor(file)) return undefined
  try {
    const st = await fs.promises.stat(file)
    if (!st.isFile() || st.size > MAX_SYNTAX_BYTES) return undefined
    return await checkSyntaxText(file, await fs.promises.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

// ---- tip (T4 c): never install a server, say how to get one ----

const TIPS: Partial<Record<SyntaxLang, string>> = {
  typescript: "typescript-language-server",
  tsx: "typescript-language-server",
  javascript: "typescript-language-server",
  python: "pyright",
  go: "gopls",
  rust: "rust-analyzer",
  java: "jdtls",
}

const tipped = new Set<string>()

/** One-line tip, once per language and process. Undefined when there is nothing useful to say. */
export function installTip(file: string): string | undefined {
  const lang = syntaxLangFor(file)
  const server = lang && TIPS[lang]
  if (!lang || !server || tipped.has(server)) return undefined
  tipped.add(server)
  return `Tip: no language server is attached for ${path.extname(file)} files. Install ${server} yourself and add it under "lsp" in ezkielyna.json to get definition, references and type info (nothing is installed automatically).`
}

export function resetTipsForTests() {
  tipped.clear()
}
