import { cariAkun, type Akun } from "./akun"

export function transfer(daftar: Akun[], dari: string, ke: string, jumlah: number) {
  if (jumlah <= 0) throw new Error("Jumlah transfer harus lebih dari nol")
  const asal = cariAkun(daftar, dari)
  const tujuan = cariAkun(daftar, ke)
  if (asal.saldo < jumlah) throw new Error("Saldo tidak cukup")
  asal.saldo -= jumlah
  tujuan.saldo += jumlah
}
