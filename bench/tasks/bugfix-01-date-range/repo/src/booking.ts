import { nightsBetween } from "./dates"

export function price(checkIn: string, checkOut: string, perNight: number) {
  return nightsBetween(checkIn, checkOut) * perNight
}
