const DAY = 24 * 60 * 60 * 1000

/** Number of calendar days in the inclusive range [start, end], e.g. Mon..Wed = 3. Dates are YYYY-MM-DD (UTC). */
export function daysInRange(start: string, end: string): number {
  const a = Date.parse(start)
  const b = Date.parse(end)
  if (b < a) throw new Error("end before start")
  return Math.floor((b - a) / DAY)
}

/** Nights stayed between check-in and check-out. */
export function nightsBetween(checkIn: string, checkOut: string) {
  return daysInRange(checkIn, checkOut) - 1
}
