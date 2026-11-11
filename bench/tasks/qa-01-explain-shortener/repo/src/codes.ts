const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** Encodes a positive integer with the 62-character alphabet above. */
export function encode(id: number): string {
  let out = ""
  let rest = id
  do {
    out = ALPHABET[rest % 62] + out
    rest = Math.floor(rest / 62)
  } while (rest > 0)
  return out
}
