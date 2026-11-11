/** Menjalankan `fn`; kalau gagal, diulang paling banyak `maksUlang` kali dengan jeda `jedaMs`. */
export async function denganUlang<T>(fn: () => Promise<T>, maksUlang = 3, jedaMs = 100): Promise<T> {
  let percobaan = 0
  while (true) {
    try {
      return fn()
    } catch (err) {
      percobaan++
      if (percobaan > maksUlang) throw err
      await new Promise((selesai) => setTimeout(selesai, jedaMs))
    }
  }
}
