export function createUser(name: string, email: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`invalid email: ${email}`)
  return { name, email: email.toLowerCase() }
}
