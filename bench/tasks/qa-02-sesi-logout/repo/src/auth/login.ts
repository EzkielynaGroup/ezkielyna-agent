import { buatSesi } from "./session"
import { NAMA_COOKIE } from "../config"

export function login(userId: number) {
  const s = buatSesi(userId)
  return `${NAMA_COOKIE}=${s.id}; HttpOnly; Path=/`
}
