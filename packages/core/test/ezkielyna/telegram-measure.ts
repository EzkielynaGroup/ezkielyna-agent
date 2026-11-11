// Measures the bridge as a separate process: RSS, idle CPU, clean exit. Usage: bun telegram-measure.ts <path-to-main.ts>
// Mocks run in THIS process; the bridge is a child, so its numbers are not polluted by the mocks.
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mockAgent, mockGateway, mockTelegram } from "./telegram-mocks"

const main = process.argv[2]!
const TOKEN = "123456789:" + "AAFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE01"
const gw = await mockGateway()
const agent = await mockAgent(gw.url, "pw")
const tg = await mockTelegram(TOKEN, 25_000) // real Telegram long-poll holds ~25 s
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-tg-m-"))
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-tg-ws-")))
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ allowedUserIds: [1001], folders: { proj: ws }, defaultFolder: "proj" }))
const child = spawn(process.execPath, [main, "run", "--server", agent.url], {
  stdio: "ignore",
  env: { PATH: process.env.PATH, HOME: os.homedir(), EZK_TELEGRAM_DIR: dir, EZK_TELEGRAM_BOT_TOKEN: TOKEN, EZK_TELEGRAM_API_BASE: tg.url, EZK_SERVER_PASSWORD: "pw", EZK_NO_KEYCHAIN: "1" },
})
const ps = (f: string) => execFileSync("ps", ["-o", `${f}=`, "-p", String(child.pid)]).toString().trim()
const cpuSec = () => { const t = ps("time"); const [m, s] = t.split(":"); return Number(m) * 60 + Number(s) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
await sleep(2500)
const rssStart = Number(ps("rss")) / 1024
for (let i = 0; i < 5; i++) { tg.say(1001, `hello ${i}`); await sleep(300) }
await sleep(1500)
const rssAfterTraffic = Number(ps("rss")) / 1024
const c0 = cpuSec(), t0 = Date.now()
await sleep(30_000)
const cpuPct = ((cpuSec() - c0) / ((Date.now() - t0) / 1000)) * 100
const rssIdle = Number(ps("rss")) / 1024
const replies = tg.texts(1001).filter((t) => t.startsWith("echo:")).length
const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)))
const t1 = Date.now()
child.kill("SIGTERM")
const code = await Promise.race([exited, sleep(5000).then(() => "timeout")])
console.log(JSON.stringify({ rssStartMB: +rssStart.toFixed(1), rssAfterTrafficMB: +rssAfterTraffic.toFixed(1), rssIdleMB: +rssIdle.toFixed(1), idleCpuPct: +cpuPct.toFixed(2), repliesSeen: replies, exitCode: code, exitMs: Date.now() - t1 }))
await Promise.all([tg.close(), agent.close(), gw.close()])
process.exit(0)
