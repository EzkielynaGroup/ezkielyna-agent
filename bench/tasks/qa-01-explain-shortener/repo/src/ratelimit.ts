const CAPACITY = 10
const REFILL_PER_SECOND = 10 / 60
const buckets = new Map<string, { tokens: number; at: number }>()

/** Token bucket per client IP: bursts of 10, refilled at 10 requests per minute. */
export function allow(ip: string, now = Date.now()) {
  const bucket = buckets.get(ip) ?? { tokens: CAPACITY, at: now }
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + ((now - bucket.at) / 1000) * REFILL_PER_SECOND)
  bucket.at = now
  if (bucket.tokens < 1) {
    buckets.set(ip, bucket)
    return false
  }
  bucket.tokens -= 1
  buckets.set(ip, bucket)
  return true
}
