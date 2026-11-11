export type FocusPollTarget = {
  window: {
    setInterval(callback: () => void, delay: number): number
    clearInterval(id: number): void
    addEventListener(type: "focus" | "blur", callback: () => void): void
    removeEventListener(type: "focus" | "blur", callback: () => void): void
  }
  document: {
    visibilityState: string
    hasFocus(): boolean
    addEventListener(type: "visibilitychange", callback: () => void): void
    removeEventListener(type: "visibilitychange", callback: () => void): void
  }
}

export function focusPollInterval(focused: boolean, activeMs: number, idleMs: number) {
  return focused ? activeMs : idleMs
}

export function createFocusPoll(
  callback: () => void,
  activeMs: number,
  idleMs: number,
  target: FocusPollTarget = { window, document },
) {
  const focused = () => target.document.visibilityState === "visible" && target.document.hasFocus()
  let isFocused = focused()
  let timer = target.window.setInterval(
    () => {
      if (focused()) callback()
    },
    focusPollInterval(isFocused, activeMs, idleMs),
  )

  const sync = () => {
    const next = focused()
    if (next === isFocused) return
    isFocused = next
    target.window.clearInterval(timer)
    timer = target.window.setInterval(
      () => {
        if (focused()) callback()
      },
      focusPollInterval(isFocused, activeMs, idleMs),
    )
    if (isFocused) callback()
  }

  target.window.addEventListener("focus", sync)
  target.window.addEventListener("blur", sync)
  target.document.addEventListener("visibilitychange", sync)

  return () => {
    target.window.clearInterval(timer)
    target.window.removeEventListener("focus", sync)
    target.window.removeEventListener("blur", sync)
    target.document.removeEventListener("visibilitychange", sync)
  }
}
