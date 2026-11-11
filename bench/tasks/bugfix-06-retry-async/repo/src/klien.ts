import { denganUlang } from "./retry"

export function ambilStok(fetcher: () => Promise<number>) {
  return denganUlang(fetcher, 2, 50)
}
