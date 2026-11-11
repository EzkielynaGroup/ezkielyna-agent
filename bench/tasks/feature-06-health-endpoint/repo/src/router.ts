const PRODUK = [
  { id: 1, nama: "Kopi Gayo 250g", harga: 85000 },
  { id: 2, nama: "Teh Tubruk", harga: 22000 },
]

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === "GET" && url.pathname === "/produk") return Response.json(PRODUK)
  return new Response("Not Found", { status: 404 })
}
