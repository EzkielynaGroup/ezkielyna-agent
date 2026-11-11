export type Akun = { id: string; saldo: number; diblokir: boolean }

export function cariAkun(daftar: Akun[], id: string) {
  const akun = daftar.find((item) => item.id === id)
  if (!akun) throw new Error("Akun tidak ditemukan")
  if (akun.diblokir) throw new Error("Akun sedang diblokir, hubungi layanan pelanggan")
  return akun
}
