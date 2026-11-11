// Ezkielyna Agent v1.1: small persisted state next to the memory files: first-use notice, private sessions, reviewer budget.
import fs from "node:fs"
import path from "node:path"

export interface MemoryState {
  noticeAccepted: boolean
  /** session ids whose memory is off (no injection, no writes, not indexed for search) */
  privateSessions: string[]
  /** sessions belonging to the active isolated profile (for profile-specific search indexes) */
  profileSessions: string[]
  reviews: { day: string; count: number }
  lastReviewAt: number
}

const MAX_PRIVATE = 200
const MAX_PROFILE_SESSIONS = 5000
export const DAILY_REVIEW_CAP = 40

export const emptyState = (): MemoryState => ({ noticeAccepted: false, privateSessions: [], profileSessions: [], reviews: { day: "", count: 0 }, lastReviewAt: 0 })

export class StateFile {
  private file: string
  constructor(dir: string) {
    this.file = path.join(dir, "state.json")
  }

  get(): MemoryState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<MemoryState>
      return {
        noticeAccepted: raw.noticeAccepted === true,
        privateSessions: Array.isArray(raw.privateSessions) ? raw.privateSessions.filter((x) => typeof x === "string") : [],
        profileSessions: Array.isArray(raw.profileSessions) ? raw.profileSessions.filter((x) => typeof x === "string").slice(-MAX_PROFILE_SESSIONS) : [],
        reviews: raw.reviews && typeof raw.reviews.day === "string" ? { day: raw.reviews.day, count: Number(raw.reviews.count) || 0 } : { day: "", count: 0 },
        lastReviewAt: Number(raw.lastReviewAt) || 0,
      }
    } catch {
      return emptyState()
    }
  }

  private save(s: MemoryState) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  update(fn: (s: MemoryState) => void) {
    const s = this.get()
    fn(s)
    this.save(s)
    return s
  }

  isPrivate(sessionID: string) {
    return this.get().privateSessions.includes(sessionID)
  }

  setPrivate(sessionID: string, on: boolean) {
    return this.update((s) => {
      s.privateSessions = s.privateSessions.filter((x) => x !== sessionID)
      if (on) s.privateSessions.push(sessionID)
      if (s.privateSessions.length > MAX_PRIVATE) s.privateSessions = s.privateSessions.slice(-MAX_PRIVATE)
    })
  }

  markProfileSession(sessionID: string) {
    return this.update((s) => {
      if (s.profileSessions.includes(sessionID)) return
      s.profileSessions.push(sessionID)
      if (s.profileSessions.length > MAX_PROFILE_SESSIONS) s.profileSessions = s.profileSessions.slice(-MAX_PROFILE_SESSIONS)
    })
  }

  acceptNotice() {
    return this.update((s) => {
      s.noticeAccepted = true
    })
  }
}
