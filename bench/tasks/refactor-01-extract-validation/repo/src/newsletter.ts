const subscribers = new Set<string>()

export function subscribe(email: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`invalid email: ${email}`)
  subscribers.add(email.toLowerCase())
  return subscribers.size
}
