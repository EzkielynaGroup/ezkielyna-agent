#!/usr/bin/env bun
// Ezkielyna brand guard: fails when a NEW user-visible upstream brand string appears in packages/*/src,
// or when a supplier name appears anywhere in packages/*/src (locale files included).
//
//   bun script/ezk-brand-guard.ts            # check the repository
//   bun script/ezk-brand-guard.ts --update   # print the current unallowed hits (to triage, never auto-writes the allowlist)
//
// Allowlist (script/ezk-brand-allowlist.txt): one `path-glob:pattern` per line, `#` starts a comment.
//   pattern = literal substring of the offending line, or `re:<regex>`. The glob is relative to the repo root.
import fs from "node:fs"
import path from "node:path"

export const BRAND = /opencode|opncd\.ai|anomalyco/i

// Internal identifiers that must keep the upstream name (package names, env vars, config dir/files, schema ids,
// protocol/type identifiers). Everything left on a line after removing these is treated as user-visible.
const INTERNAL: RegExp[] = [
  /@opencode-ai\/[\w\-./]*/g, // package names and import paths
  /\bopencode-ai[\w\-]*/g,
  /\bOPENCODE_\w*/g, // env vars and constants
  /https:\/\/opencode\.ai\/(?:desktop-theme|theme|config|tui)\.json/g, // JSON schema ids
  /\.well-known\/opencode/g,
  /(?<![\w])\.opencode\b/g, // config directory
  /opencode\.jsonc?/g,
  /\bopencode\.(?!ai\b)[a-z]\w*/gi, // command ids, storage keys, opencode.local, opencode.db
  /["'`]opencode["'`]/g, // provider/theme/integration ids
  /\bopencode(?=\s*[:=]\s)/g, // object keys
  /\w+opencode\w*/gi, // camel/pascal/snake identifiers containing the name
  /\bopencode(?:[A-Z_]\w*|-[\w\-]+)/g,
  /\bOpenCode(?=[A-Z]\w*)/g,
  /\bOpencode(?=[A-Z]\w*|\b)(?=[\w]*)/g,
  /(?<![\w])opencode(?=\/[\w$])/g, // opencode/${version} user agent, opencode/branch
  /\bopencode(?=\.internal|\.local)/g,
  /["'`][\w.:\-]*opencode[\w.:\-]*["'`]/g, // quoted identifiers: keys, ids, storage names, event names
  /(?<=\/)opencode(?=\/|["'`\s)]|$)/g, // path segments such as ~/.config/opencode/
  /(?<=\w\.)opencode\b(?!\.ai)/g, // property access: ProviderV2.ID.opencode
  /\banomalyco\/tree-sitter-[\w-]+/g, // third-party parser assets hosted under the upstream org
]

// Upstream/vendor names that must never reach users. The real list is private to the maintainers, so it is read
// from EZK_PRIVATE_TERMS (comma-separated, case-insensitive) or an untracked `script/ezk-private-terms.txt`
// (one term per line). The public repository only ships the generic patterns below plus a placeholder vendor name.
function privateTerms(): RegExp[] {
  const raw: string[] = (process.env.EZK_PRIVATE_TERMS ?? "").split(",")
  const file = path.join(import.meta.dir, "ezk-private-terms.txt")
  if (fs.existsSync(file)) raw.push(...fs.readFileSync(file, "utf8").split("\n"))
  return raw
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith("#"))
    .map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))
}

const SUPPLIERS: RegExp[] = [
  /ExampleVendor/i, // placeholder, keeps the supplier check covered by tests without naming a real upstream
  ...privateTerms(),
  /\bPartner\b/, // supplier label, case-sensitive so ordinary prose ("partner") is not flagged
  /\bMac\b.{0,40}\b(?:upstream|supplier|backend|gateway)\b/i, // "Mac" used as an upstream name
  /\b(?:upstream|supplier|backend|gateway)\b.{0,40}\bMac\b/i,
]

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".jsonc", ".md", ".mdx", ".txt", ".astro", ".html", ".css", ".svelte"])
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "out", "generated", "generated-effect"])
const TEST_PATH = /(^|\/)(test|tests|e2e|__tests__)\/|\.(test|spec|stories)\.[a-z]+$/
const COMMENT_ONLY = /^\s*(\/\/|\/\*|\*|#|<!--)/

export type Allow = { glob: Bun.Glob; raw: string; match: (line: string) => boolean }
export type Hit = { file: string; line: number; kind: "brand" | "supplier"; text: string }

export function parseAllowlist(text: string): Allow[] {
  const out: Allow[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const i = line.indexOf(":")
    if (i <= 0 || i === line.length - 1) throw new Error(`bad allowlist line (want path:pattern): ${line}`)
    const glob = new Bun.Glob(line.slice(0, i).trim())
    const pat = line.slice(i + 1).trim()
    const match = pat.startsWith("re:") ? ((re) => (l: string) => re.test(l))(new RegExp(pat.slice(3))) : (l: string) => l.includes(pat)
    out.push({ glob, raw: line, match })
  }
  return out
}

/** True when the line still names the upstream product after internal identifiers are removed. */
export function isUserVisibleBrand(line: string): boolean {
  let rest = line
  for (const re of INTERNAL) rest = rest.replace(re, " ")
  return BRAND.test(rest)
}

export function checkLine(file: string, n: number, line: string, allow: Allow[]): Hit | undefined {
  const supplier = SUPPLIERS.some((re) => re.test(line))
  if (supplier) return { file, line: n, kind: "supplier", text: line.trim().slice(0, 160) } // never allowlisted
  const ext = path.extname(file)
  const prose = ext === ".md" || ext === ".mdx" || ext === ".txt"
  if (!prose && COMMENT_ONLY.test(line)) return
  if (/^\s*import\b.*\bfrom\b|^\s*export\b.*\bfrom\b/.test(line)) return
  if (!BRAND.test(line) || !isUserVisibleBrand(line)) return
  if (allow.some((a) => a.glob.match(file) && a.match(line))) return
  return { file, line: n, kind: "brand", text: line.trim().slice(0, 160) }
}

function* walk(dir: string, rel: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    const r = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* walk(abs, r)
    else if (TEXT_EXT.has(path.extname(entry.name))) yield r
  }
}

export function scan(root: string, allow: Allow[]): Hit[] {
  const hits: Hit[] = []
  const pkgs = path.join(root, "packages")
  if (!fs.existsSync(pkgs)) return hits
  for (const pkg of fs.readdirSync(pkgs)) {
    const src = path.join(pkgs, pkg, "src")
    if (!fs.existsSync(src)) continue
    for (const f of walk(src, `packages/${pkg}/src`)) {
      if (TEST_PATH.test(f)) continue
      const lines = fs.readFileSync(path.join(root, f), "utf8").split("\n")
      lines.forEach((l, i) => {
        const hit = checkLine(f, i + 1, l, allow)
        if (hit) hits.push(hit)
      })
    }
  }
  return hits
}

export function main(root = path.resolve(import.meta.dir, "..")): number {
  const allowFile = path.join(root, "script/ezk-brand-allowlist.txt")
  const allow = parseAllowlist(fs.existsSync(allowFile) ? fs.readFileSync(allowFile, "utf8") : "")
  const hits = scan(root, allow)
  if (hits.length === 0) {
    console.log("ezk-brand-guard: ok")
    return 0
  }
  for (const h of hits) console.error(`${h.file}:${h.line} [${h.kind}] ${h.text}`)
  console.error(
    `\nezk-brand-guard: ${hits.length} violation(s). Use "Ezkielyna Agent"/"ezkielyna" and https://ezkielyna.store links; ` +
      `if the string is an internal identifier, add "path-glob:pattern" to script/ezk-brand-allowlist.txt. Supplier names can never be allowlisted.`,
  )
  return 1
}

if (import.meta.main) process.exit(main())
