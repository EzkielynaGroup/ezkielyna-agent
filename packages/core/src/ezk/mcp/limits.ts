// Small helpers shared by the MCP robustness code (pure).

/** Head cap with a visible note; the caller still spills the full text through the shared truncation API. */
export function capChars(text: string, max: number): { text: string; omitted: number } {
  if (text.length <= max) return { text, omitted: 0 }
  return { text: text.slice(0, max), omitted: text.length - max }
}

export class DeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${Math.round(ms / 1000)}s`)
  }
}

export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new DeadlineError(what, ms)), ms)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}
