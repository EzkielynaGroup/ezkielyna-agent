import { SESSION_TTL_DETIK } from "../config"

export type Sesi = { id: string; userId: number; kedaluwarsa: number }

const sesi = new Map<string, Sesi>()

export function buatSesi(userId: number): Sesi {
  const baru = { id: crypto.randomUUID(), userId, kedaluwarsa: Date.now() + SESSION_TTL_DETIK }
  sesi.set(baru.id, baru)
  return baru
}

export function ambilSesi(id: string, sekarang = Date.now()) {
  const ada = sesi.get(id)
  if (!ada) return undefined
  if (sudahLewat(ada, sekarang)) {
    sesi.delete(id)
    return undefined
  }
  return ada
}

function sudahLewat(s: Sesi, sekarang: number) {
  return sekarang >= s.kedaluwarsa
}
