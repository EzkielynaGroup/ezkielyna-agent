// Ezkielyna Agent v3 (Wave C, codeintel): lazy tree-sitter grammars for TS/JS, Python, Go, Rust and Java.
// Nothing loads until a caller asks for a language: the runtime wasm on first use, then one grammar per language.
// The wasm files are static `import(..., { with: { type: "wasm" } })` specifiers so `bun build --compile` embeds them,
// exactly like the bash/PowerShell parsers in `opencode/src/tool/shell.ts` (one loader is meant to serve both lanes:
// see INTEGRATION-WC-codeintel.md).
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Language, Parser, Tree } from "web-tree-sitter"

export type GrammarID = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "java" | "json" | "yaml"

export const GRAMMARS: readonly GrammarID[] = ["typescript", "tsx", "javascript", "python", "go", "rust", "java", "json", "yaml"]

const EXTENSIONS: Record<string, GrammarID> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
}

/** Grammar for a file name, or undefined when we do not ship one (declaration files are skipped: they repeat sources). */
export function grammarFor(file: string): GrammarID | undefined {
  if (file.endsWith(".d.ts") || file.endsWith(".d.mts") || file.endsWith(".d.cts")) return undefined
  return EXTENSIONS[path.extname(file).toLowerCase()]
}

const wasmImport = (load: () => Promise<{ default: string }>) => () => load().then((mod) => resolveWasm(mod.default))

const WASM: Record<GrammarID, () => Promise<string>> = {
  typescript: wasmImport(() => import("tree-sitter-typescript/tree-sitter-typescript.wasm" as string, { with: { type: "wasm" } })),
  tsx: wasmImport(() => import("tree-sitter-typescript/tree-sitter-tsx.wasm" as string, { with: { type: "wasm" } })),
  javascript: wasmImport(() => import("tree-sitter-javascript/tree-sitter-javascript.wasm" as string, { with: { type: "wasm" } })),
  python: wasmImport(() => import("tree-sitter-python/tree-sitter-python.wasm" as string, { with: { type: "wasm" } })),
  go: wasmImport(() => import("tree-sitter-go/tree-sitter-go.wasm" as string, { with: { type: "wasm" } })),
  rust: wasmImport(() => import("tree-sitter-rust/tree-sitter-rust.wasm" as string, { with: { type: "wasm" } })),
  java: wasmImport(() => import("tree-sitter-java/tree-sitter-java.wasm" as string, { with: { type: "wasm" } })),
  json: wasmImport(() => import("tree-sitter-json/tree-sitter-json.wasm" as string, { with: { type: "wasm" } })),
  yaml: wasmImport(() => import("@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm" as string, { with: { type: "wasm" } })),
}

function resolveWasm(asset: string) {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

export interface Grammar {
  id: GrammarID
  language: Language
  parser: Parser
}

let runtime: Promise<typeof import("web-tree-sitter")> | undefined
const grammars = new Map<GrammarID, Promise<Grammar>>()

function loadRuntime() {
  runtime ??= (async () => {
    const mod = await import("web-tree-sitter")
    const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } })
    const treePath = resolveWasm(treeWasm)
    await mod.Parser.init({ locateFile: () => treePath })
    return mod
  })().catch((error) => {
    runtime = undefined
    throw error
  })
  return runtime
}

/** Load (once) and return the parser for a grammar. Concurrent callers share the same promise. */
export function loadGrammar(id: GrammarID): Promise<Grammar> {
  const cached = grammars.get(id)
  if (cached) return cached
  const pending = (async () => {
    const mod = await loadRuntime()
    const language = await mod.Language.load(await WASM[id]())
    const parser = new mod.Parser()
    parser.setLanguage(language)
    return { id, language, parser }
  })().catch((error) => {
    grammars.delete(id)
    throw error
  })
  grammars.set(id, pending)
  return pending
}

/** Grammars loaded so far (for measurements and tests). */
export function loadedGrammars(): GrammarID[] {
  return [...grammars.keys()]
}

/**
 * Parse `source` and hand the tree to `use`; the tree is freed afterwards (wasm memory is not garbage collected).
 * Returns undefined when the grammar cannot be loaded or the parser gives up.
 */
export async function withTree<T>(id: GrammarID, source: string, use: (tree: Tree, grammar: Grammar) => T): Promise<T | undefined> {
  const grammar = await loadGrammar(id).catch(() => undefined)
  if (!grammar) return undefined
  const tree = grammar.parser.parse(source)
  if (!tree) return undefined
  try {
    return use(tree, grammar)
  } finally {
    tree.delete()
  }
}
