cat > wc.ts <<'EOF'
#!/usr/bin/env bun
const args = process.argv.slice(2)
const flags = args.filter((arg) => arg.startsWith("--"))
const file = args.find((arg) => !arg.startsWith("--"))
const unknown = flags.filter((flag) => flag !== "--lines" && flag !== "--chars")
if (!file || unknown.length > 0) {
  console.error(unknown.length > 0 ? `unknown flag: ${unknown.join(", ")}` : "usage: bun wc.ts [--lines|--chars] <file>")
  process.exit(2)
}
const text = await Bun.file(file).text()
if (flags.includes("--lines")) console.log(`${text.split("\n").length - (text.endsWith("\n") ? 1 : 0)} lines`)
else if (flags.includes("--chars")) console.log(`${[...text].length} chars`)
else console.log(`${text.split(/\s+/).filter(Boolean).length} words`)
EOF
cat > flags.test.ts <<'EOF'
import { expect, test } from "bun:test"
import path from "node:path"

test("--lines", () => {
  const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "wc.ts"), "--lines", path.join(import.meta.dir, "fixtures", "puisi.txt")])
  expect(result.stdout.toString().trim()).toBe("3 lines")
})
EOF
