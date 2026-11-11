// The environment the CI smoke scripts hand to the programs they start: the runner's own environment minus anything whose
// name looks like a credential (API keys, tokens, secrets, passwords, auth values). One copy, shared by every smoke script,
// so a change to the rule cannot reach some of them and not the others.

const SECRET_NAME = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH)/i

/**
 * Names that match SECRET_NAME but hold no credential.
 *
 * XAUTHORITY is the path of the X11 cookie file. `xvfb-run -a` creates one for its private display and exports it; an
 * Electron app that does not inherit it is refused by the X server ("Authorization required, but no authorization protocol
 * specified"), then reports "Missing X server or $DISPLAY" and "The platform failed to initialize". That is how every
 * Linux desktop smoke failed when the filter above also dropped it.
 */
const NOT_A_CREDENTIAL = new Set(["XAUTHORITY"])

export function isSecretName(name: string) {
  return !NOT_A_CREDENTIAL.has(name) && SECRET_NAME.test(name)
}

export function safeEnv(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !isSecretName(key))) as Record<string, string>
}
