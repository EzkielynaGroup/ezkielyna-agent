// Idle RSS of `serve` with the ezk features on vs off (median of N samples). Run: bun test/ezk/bench/idle-rss.ts
import { startMockGateway } from "../../../../core/test/ezk/mock-gateway"
import { startServer } from "../harness"

async function rss(features: string | undefined, label: string) {
  const gw = startMockGateway({ models: { k: ["deepseek-v4.1-flash", "minimax-m3.1-flash"] } })
  const srv = await startServer({ baseURL: gw.baseURL, key: "k", env: features === undefined ? {} : { EZK_FEATURES: features } })
  await srv.api("GET", "/config/providers")
  await Bun.sleep(6000)
  const out: number[] = []
  for (let i = 0; i < 5; i++) {
    const p = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(srv.pid)])
    out.push(Number(p.stdout.toString().trim()) / 1024)
    await Bun.sleep(1000)
  }
  await srv.stop()
  gw.stop()
  out.sort((a, b) => a - b)
  console.log(label, "RSS MB samples", out.map((x) => x.toFixed(0)).join(","), "median", out[2]!.toFixed(1))
  return out[2]!
}
const rounds: number[] = []
for (let r = 0; r < 3; r++) {
  const first = r % 2 === 0
  const a = await rss(first ? "-router,-memory,-search" : undefined, first ? "off" : "on")
  const b = await rss(first ? undefined : "-router,-memory,-search", first ? "on" : "off")
  rounds.push(first ? b - a : a - b)
}
rounds.sort((x, y) => x - y)
console.log("delta MB per round", rounds.map((x) => x.toFixed(1)).join(","), "median", rounds[1]!.toFixed(1))
