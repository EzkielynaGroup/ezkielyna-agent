export function cekPin(pin: string) {
  if (!/^\d{6}$/.test(pin)) throw new Error("PIN harus 6 digit angka")
  return true
}
