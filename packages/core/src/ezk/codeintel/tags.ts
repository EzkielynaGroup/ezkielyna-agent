// Ezkielyna Agent v3 (Wave C, codeintel): definitions and references from tree-sitter tags queries.
// References include imported names (`import { x }`, `from m import x`, `use a::x`, `import a.X`): a file that imports
// a symbol depends on its definer even when it only passes it around as a value.
// The queries follow the `queries/tags.scm` files shipped by the grammars (MIT) and Aider's repo map (Apache-2.0),
// trimmed to the kinds we index (function / method / class / type) and embedded here so the compiled binary needs
// no query files on disk. Doc comments are read from the source (adjacent comments, Python docstrings) instead of
// the `#select-adjacent!` / `#strip!` directives, which web-tree-sitter does not run.
import type { Node, Query } from "web-tree-sitter"
import { type Grammar, type GrammarID, loadGrammar, withTree } from "../treesitter/loader"

export type DefKind = "function" | "method" | "class" | "type"

export interface Def {
  name: string
  kind: DefKind
  /** 1-based */
  line: number
  signature: string
  doc: string
}

export interface Tags {
  defs: Def[]
  /** referenced identifier -> number of references in this file */
  refs: Map<string, number>
}

export const MAX_SIGNATURE = 160
export const MAX_DOC = 240

const JS_COMMON = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(method_definition name: [(property_identifier) (private_property_identifier)] @name) @definition.method
(program (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @definition.function)
(program (variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @definition.function)
(export_statement (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @definition.function)
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.class
(import_specifier name: (identifier) @name) @reference.import
(import_clause (identifier) @name) @reference.import
`

const TS = `${JS_COMMON}
(function_signature name: (identifier) @name) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(method_signature name: (property_identifier) @name) @definition.method
(abstract_method_signature name: (property_identifier) @name) @definition.method
(interface_declaration name: (type_identifier) @name) @definition.type
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.type
(type_identifier) @name @reference.type
`

const QUERIES: Partial<Record<GrammarID, string>> = {
  typescript: TS,
  tsx: TS,
  javascript: `${JS_COMMON}
(class_declaration name: (identifier) @name) @definition.class
`,
  python: `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
(call function: [(identifier) @name (attribute attribute: (identifier) @name)]) @reference.call
(import_from_statement name: (dotted_name (identifier) @name)) @reference.import
(import_from_statement name: (aliased_import name: (dotted_name (identifier) @name))) @reference.import
`,
  go: `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_spec name: (type_identifier) @name) @definition.type
(call_expression function: [(identifier) @name (selector_expression field: (field_identifier) @name)]) @reference.call
(type_identifier) @name @reference.type
`,
  rust: `
(struct_item name: (type_identifier) @name) @definition.class
(enum_item name: (type_identifier) @name) @definition.type
(union_item name: (type_identifier) @name) @definition.type
(type_item name: (type_identifier) @name) @definition.type
(trait_item name: (type_identifier) @name) @definition.type
(function_item name: (identifier) @name) @definition.function
(function_signature_item name: (identifier) @name) @definition.method
(macro_definition name: (identifier) @name) @definition.function
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call
(macro_invocation macro: (identifier) @name) @reference.call
(use_declaration argument: (scoped_identifier name: (identifier) @name)) @reference.import
(use_list (identifier) @name) @reference.import
(type_identifier) @name @reference.type
`,
  java: `
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.type
(method_declaration name: (identifier) @name) @definition.method
(method_invocation name: (identifier) @name) @reference.call
(object_creation_expression type: (type_identifier) @name) @reference.class
(import_declaration (scoped_identifier name: (identifier) @name)) @reference.import
(type_identifier) @name @reference.type
`,
}

// A function defined directly inside one of these is reported as a method.
const CLASS_LIKE = new Set(["class_definition", "impl_item", "trait_item", "class_body", "class_declaration"])
// Walk through these to reach the node that carries the doc comment / the full declaration text.
const WRAPPERS = new Set(["export_statement", "decorated_definition", "type_declaration", "ambient_declaration"])
const COMMENTS = new Set(["comment", "line_comment", "block_comment"])
const BODY_FIELDS = ["body", "value"]

// Each tags pattern is one line. Definitions run through `matches` (the outer node gives the signature and doc);
// references run as a separate name-only `captures` query, which allocates far fewer JS objects per file.
const queries = new Map<GrammarID, { defs: Query; refs: Query }>()

async function query(grammar: Grammar) {
  const cached = queries.get(grammar.id)
  if (cached) return cached
  const source = QUERIES[grammar.id]
  if (!source) return
  const { Query } = await import("web-tree-sitter")
  const lines = source.split("\n")
  const defs = lines.filter((l) => l.includes("@definition.")).join("\n")
  const refs = lines
    .filter((l) => l.includes("@reference."))
    .map((l) => l.replace(/\s*@reference\.\w+/g, "").replace(/@name\b/g, "@ref"))
    .join("\n")
  const created = { defs: new Query(grammar.language, defs), refs: new Query(grammar.language, refs) }
  queries.set(grammar.id, created)
  return created
}

/** Extract definitions and references; undefined when the grammar is unavailable. */
export async function extractTags(id: GrammarID, source: string): Promise<Tags | undefined> {
  const q = await loadGrammar(id)
    .then(query)
    .catch(() => undefined)
  if (!q) return undefined
  return withTree(id, source, (tree) => collect(id, q, tree.rootNode, source))
}

function collect(id: GrammarID, q: { defs: Query; refs: Query }, root: Node, source: string): Tags {
  const defs: Def[] = []
  const refs = new Map<string, number>()
  const seen = new Set<number>()
  for (const match of q.defs.matches(root)) {
    const name = match.captures.find((c) => c.name === "name")?.node
    const tag = match.captures.find((c) => c.name !== "name")
    if (!name || !tag || seen.has(name.startIndex)) continue
    seen.add(name.startIndex)
    defs.push({
      name: name.text,
      kind: kindOf(id, tag.name.slice("definition.".length), tag.node),
      line: name.startPosition.row + 1,
      signature: signatureOf(tag.node, source),
      doc: docOf(id, tag.node),
    })
  }
  // A name node that is a definition is not also a reference (`(type_identifier) @reference.type` matches both),
  // and a node matched by two reference patterns counts once.
  for (const capture of q.refs.captures(root)) {
    const node = capture.node
    if (seen.has(node.startIndex)) continue
    seen.add(node.startIndex)
    refs.set(node.text, (refs.get(node.text) ?? 0) + 1)
  }
  defs.sort((a, b) => a.line - b.line)
  return { defs, refs }
}

function kindOf(id: GrammarID, raw: string, node: Node): DefKind {
  if (raw === "method") return "method"
  if (raw === "class") return "class"
  if (raw === "function") {
    if (id === "python" || id === "rust") {
      let parent = node.parent
      while (parent && (parent.type === "block" || parent.type === "declaration_list" || parent.type === "decorated_definition")) parent = parent.parent
      if (parent && CLASS_LIKE.has(parent.type)) return "method"
    }
    return "function"
  }
  return "type"
}

function outer(node: Node) {
  let current = node
  while (current.parent && WRAPPERS.has(current.parent.type)) current = current.parent
  return current
}

/** Declaration text up to the body, whitespace collapsed (`export function foo(a: string): Bar`). */
export function signatureOf(node: Node, source: string): string {
  const decl = outer(node)
  // Python decorators and Rust/Java attributes start the outer node; the signature starts at the definition itself.
  const start = decl.type === "decorated_definition" ? node.startIndex : decl.startIndex
  const body = bodyOf(node)
  const newline = source.indexOf("\n", node.startIndex)
  const end = body && body.startIndex > start ? body.startIndex : newline === -1 ? node.endIndex : Math.min(node.endIndex, newline)
  const text = source
    .slice(start, end)
    .replace(/\s+/g, " ")
    .replace(/\s*(\{|=>|=|:|;)\s*$/, "")
    .trim()
  return text.length > MAX_SIGNATURE ? text.slice(0, MAX_SIGNATURE - 1) + "…" : text
}

function bodyOf(node: Node): Node | null {
  // Go `type Server struct { ... }`: stop after the `struct` / `interface` keyword.
  const goType = node.type === "type_spec" ? node.childForFieldName("type") : null
  if (goType && (goType.type === "struct_type" || goType.type === "interface_type")) return goType.child(1)
  for (const field of BODY_FIELDS) {
    const body = node.childForFieldName(field)
    if (body && field === "value" && body.type !== "arrow_function" && body.type !== "function_expression") return null
    if (body) return body
  }
  // `const foo = () => {}`: the body is on the arrow function inside the declarator.
  const declarator = node.namedChildren.find((c) => c?.type === "variable_declarator")
  const value = declarator?.childForFieldName("value")
  return value?.childForFieldName("body") ?? null
}

/** Adjacent leading comments (JSDoc, `//`, `///`, `#`) or the Python docstring, first sentence-ish, capped. */
export function docOf(id: GrammarID, node: Node): string {
  if (id === "python") {
    const first = node.childForFieldName("body")?.namedChildren[0]
    const str = first?.type === "expression_statement" ? first.namedChildren[0] : undefined
    if (str?.type === "string") return clean(str.text.replace(/^[rRuUbBfF]*("""|'''|"|')|("""|'''|"|')$/g, ""))
  }
  const decl = outer(node)
  const lines: string[] = []
  let prev = decl.previousNamedSibling
  let edge = decl.startPosition.row
  while (prev && COMMENTS.has(prev.type) && prev.endPosition.row >= edge - 1) {
    lines.unshift(prev.text)
    edge = prev.startPosition.row
    prev = prev.previousNamedSibling
  }
  return clean(lines.join("\n").replace(/^\s*(\/\*\*?|\*\/|\*|\/\/\/?|#)/gm, "").replace(/\*\/\s*$/, ""))
}

function clean(text: string) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > MAX_DOC ? flat.slice(0, MAX_DOC - 1) + "…" : flat
}
