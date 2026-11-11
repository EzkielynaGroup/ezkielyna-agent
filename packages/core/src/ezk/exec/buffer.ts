// Bounded output store for one background process: the first half of the budget keeps the head of the output, the
// second half is a ring with the newest bytes. Everything is addressed by absolute byte offsets so a reader can ask
// "what is new since offset N" even after the middle was dropped (R1 §2.1, Codex HeadTailBuffer).
export const DEFAULT_BUFFER_BYTES = 1024 * 1024

export type Slice = {
  text: string
  /** absolute offset of the end of this slice; pass it back as `from` on the next read */
  end: number
  /** bytes that were produced after `from` but are no longer stored */
  omitted: number
}

export class HeadTailBuffer {
  readonly limit: number
  private head = Buffer.alloc(0)
  private tail: Buffer[] = []
  private tailBytes = 0
  /** total bytes ever written */
  total = 0

  constructor(limit = DEFAULT_BUFFER_BYTES) {
    this.limit = Math.max(2, limit)
  }

  private get headLimit() {
    return Math.floor(this.limit / 2)
  }

  private get tailLimit() {
    return this.limit - this.headLimit
  }

  /** first absolute offset still held in the tail ring */
  private get tailStart() {
    return this.total - this.tailBytes
  }

  get stored() {
    return this.head.length + this.tailBytes
  }

  write(chunk: string | Buffer) {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk
    if (data.length === 0) return
    const room = this.headLimit - this.head.length
    const toHead = this.tailBytes === 0 && room > 0 ? data.subarray(0, room) : data.subarray(0, 0)
    if (toHead.length) this.head = Buffer.concat([this.head, toHead])
    const rest = data.subarray(toHead.length)
    this.total += data.length
    if (!rest.length) return
    const kept = rest.length > this.tailLimit ? rest.subarray(rest.length - this.tailLimit) : rest
    this.tail.push(Buffer.from(kept))
    this.tailBytes += kept.length
    while (this.tailBytes > this.tailLimit) {
      const first = this.tail[0]!
      const over = this.tailBytes - this.tailLimit
      if (first.length <= over) {
        this.tail.shift()
        this.tailBytes -= first.length
        continue
      }
      this.tail[0] = first.subarray(over)
      this.tailBytes -= over
    }
  }

  /** Output produced after absolute offset `from` (default: everything), with a marker where the middle was dropped. */
  slice(from = 0): Slice {
    const start = Math.max(0, Math.min(from, this.total))
    const headPart = start < this.head.length ? this.head.subarray(start) : Buffer.alloc(0)
    const tailFrom = Math.max(start, this.tailStart)
    const tailAll = Buffer.concat(this.tail)
    const tailPart = tailAll.subarray(tailFrom - this.tailStart)
    const gapStart = Math.max(start, this.head.length)
    const omitted = Math.max(0, this.tailStart - gapStart)
    const text = omitted
      ? decode(headPart, "end") + `\n[… ${omitted} bytes omitted …]\n` + decode(tailPart, "start")
      : decode(Buffer.concat([headPart, tailPart]), "none")
    return { text, end: this.total, omitted }
  }
}

// A cut can land inside a multi-byte UTF-8 sequence; drop the broken bytes instead of emitting U+FFFD.
function decode(buf: Buffer, trim: "start" | "end" | "none") {
  if (trim === "start") {
    const skip = buf.findIndex((byte) => (byte & 0xc0) !== 0x80)
    return buf.subarray(skip < 0 ? buf.length : skip).toString("utf-8")
  }
  if (trim === "end") return buf.subarray(0, completeLength(buf)).toString("utf-8")
  return buf.toString("utf-8")
}

function completeLength(buf: Buffer) {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const byte = buf[buf.length - back]!
    if ((byte & 0xc0) === 0x80) continue
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return need > back ? buf.length - back : buf.length
  }
  return buf.length
}
