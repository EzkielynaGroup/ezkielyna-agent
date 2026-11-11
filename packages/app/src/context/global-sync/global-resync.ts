const debounceMs = 300

export function createGlobalResync(input: {
  refresh: (options: { disposed: boolean }) => void | Promise<unknown>
  delay?: number
  schedule?: (callback: () => void, delay: number) => unknown
  cancel?: (timer: unknown) => void
}) {
  const schedule = input.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const cancel = input.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let timer: unknown
  let disposed = false
  let dirty = false
  let inFlight = false
  let closed = false

  const flush = () => {
    timer = undefined
    if (closed || !dirty || inFlight) return
    const refreshDisposed = disposed
    dirty = false
    disposed = false
    inFlight = true
    let refresh: void | Promise<unknown>
    try {
      refresh = input.refresh({ disposed: refreshDisposed })
    } catch {
      refresh = undefined
    }
    void Promise.resolve(refresh)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false
        if (dirty && timer === undefined) flush()
      })
  }

  return {
    trigger(options: { disposed?: boolean } = {}) {
      if (closed) return
      dirty = true
      disposed ||= options.disposed === true
      if (timer !== undefined) cancel(timer)
      timer = schedule(flush, input.delay ?? debounceMs)
    },
    dispose() {
      closed = true
      dirty = false
      disposed = false
      if (timer !== undefined) cancel(timer)
      timer = undefined
    },
  }
}
