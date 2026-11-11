export function invite(from: string, to: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) throw new Error(`invalid email: ${from}`)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`invalid email: ${to}`)
  return { from, to, subject: `${from} invited you` }
}
