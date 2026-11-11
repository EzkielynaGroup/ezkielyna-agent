#!/usr/bin/env bun
const file = process.argv[2]
if (!file) {
  console.error("usage: bun wc.ts <file>")
  process.exit(2)
}
const text = await Bun.file(file).text()
const words = text.split(/\s+/).filter(Boolean).length
console.log(`${words} words`)
