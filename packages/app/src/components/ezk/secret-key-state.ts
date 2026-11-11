import { createSignal, onCleanup } from "solid-js"

export function createSecretKeyState() {
  const [value, setValue] = createSignal("")
  const clear = () => setValue("")
  onCleanup(clear)
  return { value, setValue, clear }
}
