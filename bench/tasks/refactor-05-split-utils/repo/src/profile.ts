import { clamp, truncate } from "./utils"

export function profileCard(name: string, bio: string, level: number) {
  return { name, bio: truncate(bio, 20), level: clamp(level, 1, 10) }
}
