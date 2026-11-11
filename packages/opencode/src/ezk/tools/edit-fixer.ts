import { createHash } from "node:crypto"
import { ezkRuntime } from "../../plugin/ezk/runtime"

const MAX_FILE_BYTES = 256 * 1024
const MAX_SEARCH_CHARS = 8_000
const MAX_RESPONSE_BYTES = 16 * 1024

export class EditFixCache {
  private values = new Map<string, string>()

  constructor(private readonly max = 50) {}

  get(key: string) {
    const value = this.values.get(key)
    if (value === undefined) return
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }

  set(key: string, value: string) {
    this.values.delete(key)
    this.values.set(key, value)
    while (this.values.size > this.max) this.values.delete(this.values.keys().next().value as string)
  }

  get size() {
    return this.values.size
  }
}

const cache = new EditFixCache(50)

export function validateCorrection(response: string, original: string, content: string) {
  try {
    const json = JSON.parse(response) as Record<string, unknown>
    if (
      !json ||
      Object.keys(json).length !== 1 ||
      typeof json.oldString !== "string" ||
      json.oldString === original ||
      !json.oldString.length
    )
      return
    const first = content.indexOf(json.oldString)
    if (first < 0 || content.indexOf(json.oldString, first + 1) >= 0) return
    return json.oldString
  } catch {
    return
  }
}

/** One bounded gateway call. It sees only the source text and search string, and can return only a corrected search string. */
export async function fixOldString(content: string, oldString: string): Promise<string | undefined> {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES || oldString.length > MAX_SEARCH_CHARS) return
  const rt = ezkRuntime()
  if (!rt.flags.tools.editFixer) return
  const key = rt.key()
  if (!key) return
  const cacheKey = createHash("sha256").update(content).update("\0").update(oldString).digest("hex")
  const cached = cache.get(cacheKey)
  if (cached) return cached
  try {
    await rt.ensureAllowed()
    const model = rt.engine.policy.flash.find((id) => rt.engine.allowed.ids.has(id))
    if (!model) return
    const response = await fetch(`${rt.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: 'Return JSON only: {"oldString":"..."}. Correct only the search string so it exactly matches one unique span in the file. Do not suggest or change replacement text.',
          },
          { role: "user", content: JSON.stringify({ oldString, content }) },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    })
    if (!response.ok) return
    const bodyText = await readResponse(response, MAX_RESPONSE_BYTES)
    if (bodyText === undefined) return
    const body = JSON.parse(bodyText) as { choices?: { message?: { content?: string } }[] }
    const corrected = validateCorrection(body.choices?.[0]?.message?.content ?? "", oldString, content)
    if (corrected) cache.set(cacheKey, corrected)
    return corrected
  } catch {
    return
  }
}

async function readResponse(response: Response, maxBytes: number) {
  const reader = response.body?.getReader()
  if (!reader) return
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return
      }
      chunks.push(next.value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks, size))
  } finally {
    reader.releaseLock()
  }
}
