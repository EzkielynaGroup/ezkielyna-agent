import { terimaUpload } from "./upload"

const html = await terimaUpload(Bun.file(process.argv[2] ?? "contoh.csv"))
await Bun.write("laporan.html", html)
