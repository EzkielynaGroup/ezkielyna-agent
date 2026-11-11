const recoveryDelay = 8_000
const repeatDelay = 30_000

export type RecoveryAction = "reload" | "relaunch" | "export-logs" | "quit" | "wait"

/**
 * A renderer that stays unresponsive is offered the same way out as every other failed window: Reload, Relaunch, Export logs, Quit, or
 * Wait. "Wait" is not final: the question comes back every 30 s while the renderer is still stuck. A "Reload" answered after the
 * renderer has recovered is ignored (it would throw away a working window); the other answers are explicit and always honoured.
 */
export function createUnresponsiveRecovery(input: {
  show: () => Promise<RecoveryAction>
  reload: () => void
  relaunch?: () => void
  quit?: () => void
  exportLogs?: () => void | Promise<void>
  delay?: number
  repeatDelay?: number
  schedule?: (callback: () => void, delay: number) => unknown
  cancel?: (timer: unknown) => void
}) {
  const schedule = input.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const cancel = input.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let timer: unknown
  let unresponsive = false
  let generation = 0
  let disposed = false

  const arm = (attempt: number, delay: number) => {
    timer = schedule(() => {
      timer = undefined
      if (disposed || !unresponsive || attempt !== generation) return
      void prompt(attempt)
    }, delay)
  }

  const prompt = async (attempt: number): Promise<void> => {
    try {
      const action = await Promise.resolve().then(input.show)
      const stale = disposed || !unresponsive || attempt !== generation
      if (action === "relaunch") return input.relaunch?.()
      if (action === "quit") return input.quit?.()
      if (action === "export-logs") {
        await input.exportLogs?.()
        if (!disposed && unresponsive && attempt === generation) return prompt(attempt)
        return
      }
      if (stale) return
      if (action === "reload") return input.reload()
      arm(attempt, input.repeatDelay ?? repeatDelay) // wait: ask again if it is still stuck
    } catch {
      // A failing dialog must not leave the window without any recovery attempt: ask again later.
      if (!disposed && unresponsive && attempt === generation) arm(attempt, input.repeatDelay ?? repeatDelay)
    }
  }

  return {
    unresponsive() {
      if (disposed || unresponsive) return
      unresponsive = true
      const attempt = ++generation
      arm(attempt, input.delay ?? recoveryDelay)
    },
    responsive() {
      if (disposed) return
      unresponsive = false
      generation++
      if (timer !== undefined) cancel(timer)
      timer = undefined
    },
    dispose() {
      disposed = true
      unresponsive = false
      generation++
      if (timer !== undefined) cancel(timer)
      timer = undefined
    },
  }
}
