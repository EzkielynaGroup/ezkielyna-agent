import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { friendlyMessage, installStreamGuards, onPipeBroken } from "./ezkielyna-guards"

const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" })

describe("process guards", () => {
  test("an EPIPE on stdout/stderr is swallowed and switches console logging off (regression: native JS error dialog)", () => {
    const out = new PassThrough()
    const err = new PassThrough()
    installStreamGuards([out, err])
    let broken = 0
    onPipeBroken(() => broken++)
    // Without a listener, emitting 'error' on a stream throws: that is exactly what crashed the main process.
    expect(() => out.emit("error", epipe())).not.toThrow()
    expect(() => err.emit("error", Object.assign(new Error("destroyed"), { code: "ERR_STREAM_DESTROYED" }))).not.toThrow()
    expect(broken).toBe(2)
  })

  test("other stream errors do not crash the app either", () => {
    const s = new PassThrough()
    installStreamGuards([s])
    expect(() => s.emit("error", new Error("weird"))).not.toThrow()
  })

  test("a real closed pipe raises EPIPE asynchronously and is survived", async () => {
    const { spawn } = await import("node:child_process")
    // Child writes into a pipe whose read end this process closes immediately.
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{process.stdout.on('error',()=>{});for(let i=0;i<50;i++)process.stdout.write('x'.repeat(65536));setTimeout(()=>process.exit(0),200)},300)"], { stdio: ["ignore", "pipe", "ignore"] })
    child.stdout.destroy()
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
    expect(code).toBe(0)
  })

  test("friendly error text is bilingual and never contains a key", () => {
    const e = new Error("failed with sk-" + "abcdefghijklmnopqrstuvwxyz0123")
    expect(friendlyMessage(e, "id_ID.UTF-8").body).toContain("tetap berjalan")
    expect(friendlyMessage(e, "en_US.UTF-8").body).toContain("still running")
    expect(friendlyMessage(e, "en").body).not.toContain("abcdefghijkl")
  })
})
