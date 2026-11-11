cat > src/router.ts <<'EOF'
import { VERSI } from "./versi"

const PRODUK = [
  { id: 1, nama: "Kopi Gayo 250g", harga: 85000 },
  { id: 2, nama: "Teh Tubruk", harga: 22000 },
]

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === "/health") {
    if (req.method !== "GET") return Response.json({ error: "method tidak diizinkan" }, { status: 405 })
    return Response.json({ status: "ok", versi: VERSI })
  }
  if (req.method === "GET" && url.pathname === "/produk") return Response.json(PRODUK)
  return Response.json({ error: "tidak ditemukan" }, { status: 404 })
}
EOF
cat > src/health.test.ts <<'EOF'
import { expect, test } from "bun:test"
import { handle } from "./router"

test("/health", async () => {
  expect((await handle(new Request("http://x/health"))).status).toBe(200)
})
EOF
