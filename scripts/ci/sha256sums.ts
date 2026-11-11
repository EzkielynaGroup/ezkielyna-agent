#!/usr/bin/env bun
// Writes <dir>/SHA256SUMS for every file directly in <dir>, in `sha256sum` format (verify with `sha256sum -c SHA256SUMS`).
//
//   bun scripts/ci/sha256sums.ts artifacts
import { readdir } from "node:fs/promises"
import path from "node:path"

const dir = process.argv[2]
if (!dir) {
  console.error("usage: bun scripts/ci/sha256sums.ts <dir>")
  process.exit(2)
}

const entries = await readdir(dir, { withFileTypes: true })
const files = entries
  .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
  .map((entry) => entry.name)
  .sort()
if (files.length === 0) {
  console.error(`no files in ${dir}`)
  process.exit(1)
}

const lines = await Promise.all(
  files.map(async (name) => {
    const hasher = new Bun.CryptoHasher("sha256")
    for await (const chunk of Bun.file(path.join(dir, name)).stream()) hasher.update(chunk)
    return `${hasher.digest("hex")}  ${name}`
  }),
)
await Bun.write(path.join(dir, "SHA256SUMS"), lines.join("\n") + "\n")
console.log(lines.join("\n"))
