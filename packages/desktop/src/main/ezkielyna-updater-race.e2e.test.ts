// Round-4 L-1/M-1: two install helpers started for one update (a double click on Restart) must not destroy the rollback copy, and the
// update must never be staged inside the folder that holds the app. Real ditto/codesign/plutil, fake app, macOS only.
import { describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FetchLike } from "../../../core/src/ezkielyna-update"
import { createVerifiedBackend } from "./ezkielyna-updater"

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-race-"))
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()

function app(root: string, version: string) {
  const bundle = path.join(root, "Ezkielyna Agent.app")
  const exe = path.join(bundle, "Contents", "MacOS", "Ezkielyna Agent")
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(
    path.join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>store.ezkielyna.agent</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>Ezkielyna Agent</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`,
  )
  fs.writeFileSync(exe, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const signed = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", bundle], { encoding: "utf8" })
  if (signed.status !== 0) throw new Error(`codesign failed: ${signed.stderr}`)
  return bundle
}
const version = (bundle: string) => /<key>CFBundleShortVersionString<\/key><string>([^<]*)/.exec(fs.readFileSync(path.join(bundle, "Contents/Info.plist"), "utf8"))?.[1]

describe("macOS install helper, concurrency", () => {
  test.skipIf(process.platform !== "darwin")("two helpers for one update install once, keep the backup, and stage outside the app folder", async () => {
    const zipSource = app(path.join(temp, "build"), "99.0.0")
    const zipPath = path.join(temp, "new.zip")
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", zipSource, zipPath])
    const zip = fs.readFileSync(zipPath)
    const name = "ezkielyna-agent-99.0.0-mac-arm64.zip"
    const manifest = JSON.stringify({ version: "99.0.0", downloads: { desktop: { "mac-arm64": { zip: { file: name, sha256: createHash("sha256").update(zip).digest("hex"), size: zip.byteLength } } }, cli: {} } })
    const files: Record<string, Buffer> = { "latest.json": Buffer.from(manifest), "latest.json.sig": sign("sha256", Buffer.from(manifest), { key: pair.privateKey, dsaEncoding: "der" }), [name]: zip }
    const fetchFake: FetchLike = async (url) => {
      const body = files[decodeURIComponent(url.split("/").pop() as string)]
      return { ok: !!body, status: body ? 200 : 404, arrayBuffer: async () => new Uint8Array(body ?? Buffer.alloc(0)).buffer as ArrayBuffer }
    }
    const open = path.join(temp, "open")
    fs.writeFileSync(open, "#!/bin/sh\nexit 0\n", { mode: 0o755 })

    for (let round = 0; round < 3; round++) {
      const home = path.join(temp, `home-${round}`)
      const applications = path.join(temp, `Applications-${round}`)
      const old = app(applications, "1.0.0")
      const waiter = spawnSync("/bin/sh", ["-c", "/bin/sleep 1 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" })
      let helper = ""
      const backend = createVerifiedBackend({
        base: "https://ezkielyna.store/agent/update",
        currentVersion: "1.0.0",
        updatesDir: path.join(home, "updates"),
        platform: "darwin",
        arch: "arm64",
        env: { HOME: home, PATH: process.env.PATH },
        fetch: fetchFake,
        pem,
        appPath: old,
        appPid: Number(waiter.stdout.trim()),
        homeDir: home,
        openCommand: open,
        waitTimeoutSeconds: 10,
        openExternal: () => {},
        quit() {},
        spawnDetached: (_command, args) => void (helper = args[0]!),
      })
      await backend.checkForUpdates()
      expect(await backend.downloadUpdate()).toEqual({ installMode: "swap" })
      expect(fs.readdirSync(applications)).toEqual(["Ezkielyna Agent.app"]) // nothing staged beside the app
      backend.quitAndInstall()
      const run = () => new Promise<number | null>((resolve) => spawn("/bin/sh", [helper], { stdio: "ignore" }).once("close", resolve))
      await Promise.all([run(), run()])
      const backup = path.join(home, "Library", "Application Support", "ezkielyna", "app-backup", "Ezkielyna Agent.app")
      expect(version(old)).toBe("99.0.0")
      expect(version(backup)).toBe("1.0.0") // the rollback copy survived the race
      expect(fs.readdirSync(applications)).toEqual(["Ezkielyna Agent.app"]) // swap temp is gone again
      expect(fs.existsSync(path.dirname(helper))).toBe(false) // stage removed
    }
  })
})

process.on("exit", () => fs.rmSync(temp, { recursive: true, force: true }))
