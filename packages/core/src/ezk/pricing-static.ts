import type { Price } from "./pricing"

/** Offline fallback values; keeping this tiny leaf separate avoids loading pricing I/O when metadata is off. */
export const STATIC_PRICES: Record<string, Price> = {
  "deepseek-v4.1-flash": { ratio: 0.001875, completion: 5.666667, cache: 0.25, groupRatio: 1 },
  "minimax-m3.1-flash": { ratio: 0.0125, completion: 4.25, cache: 0.25, groupRatio: 1 },
  "deepseek-v4-pro-0813": { ratio: 0.111375, completion: 3, cache: 0.0333, groupRatio: 1 },
  "default-model": { ratio: 0.0178125, completion: 3.333333, cache: 0.25, groupRatio: 1 },
  "balanced-model": { ratio: 0.0140625, completion: 4.222222, cache: 0.25, groupRatio: 1 },
  "fast-model": { ratio: 0.0059375, completion: 4.210526, cache: 0.25, groupRatio: 1 },
  "claude-opus-5.5": { ratio: 0.151875, completion: 5, cache: 0.25, groupRatio: 1.5 },
  "claude-sonnet-5.5": { ratio: 0.1062, completion: 5, cache: 0.1, groupRatio: 1.5 },
}
