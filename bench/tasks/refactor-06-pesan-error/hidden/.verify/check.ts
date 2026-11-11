// Hidden structural checks for this refactor task (run by verify after the agent finishes).
import { readdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"

const problems: string[] = []
const fail = (message: string) => problems.push(message)
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")
const sources = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file))
    .map((file) => path.join(dir, file))

const messages = [
  "Akun tidak ditemukan",
  "Akun sedang diblokir, hubungi layanan pelanggan",
  "Jumlah transfer harus lebih dari nol",
  "Saldo tidak cukup",
  "PIN harus 6 digit angka",
]
const pesan = read("src/pesan.ts")
if (!/export const PESAN\b/.test(pesan)) fail("src/pesan.ts must export const PESAN")
for (const message of messages) if (!pesan.includes(message)) fail(`src/pesan.ts is missing "${message}"`)
for (const name of ["akun.ts", "transfer.ts", "pin.ts"]) {
  const text = read(path.join("src", name))
  for (const message of messages) if (text.includes(message)) fail(`src/${name} still hard-codes "${message}"`)
  if (!/PESAN\./.test(text)) fail(`src/${name} does not use PESAN`)
}

if (problems.length) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"))
  process.exit(1)
}
console.log("structure ok")
