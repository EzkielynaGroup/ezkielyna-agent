import { ambilSesi } from "./session"

export function wajibLogin(cookie: string | null) {
  const id = cookie?.match(/sid=([^;]+)/)?.[1]
  return id ? ambilSesi(id) : undefined
}
