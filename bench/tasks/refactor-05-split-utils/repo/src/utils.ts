export function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

export function average(values: number[]) {
  return values.length === 0 ? 0 : sum(values) / values.length
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
