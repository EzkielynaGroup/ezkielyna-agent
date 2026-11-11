/** Bounded, UTF-8 aware presentation helpers shared by tool output paths. */
export function headTailPreview(text: string, previewChars = 2_000) {
  const size = Math.max(2, Math.floor(previewChars))
  const half = Math.floor(size / 2)
  let head = text.length <= size ? text : text.slice(0, half)
  let tail = text.length <= size ? "" : text.slice(-half)
  if (head.length > half) head = head.slice(0, half)
  if (tail.length > half) tail = tail.slice(-half)
  // Do not leave half of a UTF-16 surrogate pair at either edge.
  if (head.length && /[\uD800-\uDBFF]/.test(head.at(-1)!)) head = head.slice(0, -1)
  if (tail.length && /[\uDC00-\uDFFF]/.test(tail[0]!)) tail = tail.slice(1)
  const omittedBytes = Math.max(0, Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail))
  return { head, tail, omittedBytes }
}

export function countLines(text: string) {
  let count = 1
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++
  return count
}

export function formatOmittedBytes(head: string, tail: string, omittedBytes: number, suffix = "") {
  return `${head}\n[… ${Math.max(0, Math.floor(omittedBytes))} bytes omitted …]\n${tail}${suffix}`
}

export function formatStreamPreview(head: string, tail: string, totalBytes: number) {
  if (head.length && /[\uD800-\uDBFF]/.test(head.at(-1)!)) head = head.slice(0, -1)
  if (tail.length && /[\uDC00-\uDFFF]/.test(tail[0]!)) tail = tail.slice(1)
  const omittedBytes = Math.max(0, totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail))
  return { head, tail, omittedBytes, content: formatOmittedBytes(head, tail, omittedBytes) }
}

/** Conservative dependency-free text token estimate, bounded to short tool-result buffers. */
export function estimateTokenCount(text: string) {
  let count = 0
  const parts = text.matchAll(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)
  for (const [part] of parts) {
    const nonAscii = /[^\x00-\x7f]/u.test(part)
    count += nonAscii ? [...part].length : Math.ceil(part.length / 4)
  }
  return count
}
