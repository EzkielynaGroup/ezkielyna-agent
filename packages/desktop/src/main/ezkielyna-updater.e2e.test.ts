import { afterAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FetchLike } from "../../../core/src/ezkielyna-update"
import { createVerifiedBackend } from "./ezkielyna-updater"

const BASE = "https://ezkielyna.store/agent/update"
const PAGE = "https://ezkielyna.store/agent/beta"
const VERSION_1 = "1.0.0"
const VERSION_99 = "99.0.0"
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-mac-update-e2e-"))
let server: Server | undefined

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  fs.rmSync(temp, { recursive: true, force: true })
})

describe("macOS updater local e2e", () => {
  test.skipIf(process.platform !== "darwin")("verifies and swaps a fake app, then restores it on helper failure", async () => {
    const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
    fs.writeFileSync(path.join(temp, "test-signing.pem"), privateKey, { mode: 0o600 })
    fs.writeFileSync(path.join(temp, "test-signing.pub.pem"), publicKey, { mode: 0o600 })

    const appFor = (version: string, name: string) => {
      const bundle = path.join(temp, name, "Ezkielyna Agent.app")
      const executable = path.join(bundle, "Contents", "MacOS", "Ezkielyna Agent")
      fs.mkdirSync(path.dirname(executable), { recursive: true })
      fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>store.ezkielyna.agent</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>Ezkielyna Agent</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`)
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      fs.chmodSync(executable, 0o755)
      const result = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", bundle], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(`test app codesign failed: ${result.stderr}`)
      return bundle
    }
    const oldBundle = appFor(VERSION_1, "Applications")
    const baselineZip = path.join(temp, "version-1.zip")
    const baseline = execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", oldBundle, baselineZip])
    expect(baseline).toBeDefined()
    const newBundle = appFor(VERSION_99, "build-99")
    const archive = path.join(temp, "version-99.zip")
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", newBundle, archive])
    const zip = fs.readFileSync(archive)
    const artifactName = `ezkielyna-agent-${VERSION_99}-mac-arm64.zip`
    const manifest = JSON.stringify({
      version: VERSION_99,
      downloadPage: PAGE,
      downloads: {
        desktop: {
          "mac-arm64": {
            zip: {
              file: artifactName,
              sha256: createHash("sha256").update(zip).digest("hex"),
              size: zip.byteLength,
            },
          },
        },
        cli: {},
      },
    })
    const signature = sign("sha256", Buffer.from(manifest), { key: keyPair.privateKey, dsaEncoding: "der" })
    const files = new Map<string, Buffer>([
      ["latest.json", Buffer.from(manifest)],
      ["latest.json.sig", signature],
      [artifactName, zip],
    ])
    server = createServer((request, response) => {
      const name = path.posix.basename(new URL(request.url ?? "/", "http://127.0.0.1").pathname)
      const body = files.get(name)
      response.statusCode = body ? 200 : 404
      response.end(body)
    })
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject)
      server?.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("local HTTP server did not bind")
    const local = `http://127.0.0.1:${address.port}`
    const fetchLocal: FetchLike = async (url, init) => {
      const response = await fetch(`${local}${new URL(url).pathname}`, init)
      return { ok: response.ok, status: response.status, url: response.url, arrayBuffer: () => response.arrayBuffer() }
    }
    const fakeBin = path.join(temp, "bin")
    const opened = path.join(temp, "opened.log")
    fs.mkdirSync(fakeBin)
    const open = path.join(fakeBin, "open")
    fs.writeFileSync(open, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OPEN_LOG"\nexit 0\n', { mode: 0o700 })
    fs.chmodSync(open, 0o700)
    const env = { HOME: temp, PATH: `${fakeBin}:${process.env.PATH}`, OPEN_LOG: opened }
    const baseInput = {
      base: BASE,
      currentVersion: VERSION_1,
      updatesDir: path.join(temp, "updates"),
      platform: "darwin" as const,
      arch: "arm64",
      env,
      fetch: fetchLocal,
      pem: publicKey,
      appPid: 2147483647,
      waitTimeoutSeconds: 1,
      openCommand: open,
      openExternal: (url: string) => fs.appendFileSync(opened, `${url}\n`),
      quit() {},
    }

    const success = createVerifiedBackend({ ...baseInput, appPath: oldBundle, homeDir: temp,
      spawnDetached: (command, args, childEnv) => {
        const result = spawnSync(command, args, { encoding: "utf8", env: childEnv })
        if (result.status !== 0) throw new Error(`test install helper failed: ${result.stderr}`)
      },
    })
    await success.checkForUpdates()
    expect(await success.downloadUpdate()).toEqual({ installMode: "swap" })
    success.quitAndInstall()
    expect(fs.readFileSync(path.join(oldBundle, "Contents", "Info.plist"), "utf8")).toContain(VERSION_99)
    const backup = path.join(temp, "Library", "Application Support", "ezkielyna", "app-backup", "Ezkielyna Agent.app")
    expect(fs.readFileSync(path.join(backup, "Contents", "Info.plist"), "utf8")).toContain(VERSION_1)
    expect(fs.readFileSync(opened, "utf8")).toContain(oldBundle)

    const rollbackBundle = appFor(VERSION_1, "Applications-rollback")
    const failure = createVerifiedBackend({ ...baseInput, appPath: rollbackBundle, homeDir: path.join(temp, "rollback-home"),
      spawnDetached: (command, args, childEnv) => {
        const script = fs.readFileSync(args[0], "utf8")
        const newApp = /^NEW_APP='(.*)'$/m.exec(script)?.[1]
        expect(newApp).toBeDefined()
        fs.rmSync(newApp as string, { recursive: true, force: true })
        spawnSync(command, args, { encoding: "utf8", env: childEnv })
      },
    })
    await failure.checkForUpdates()
    expect(await failure.downloadUpdate()).toEqual({ installMode: "swap" })
    failure.quitAndInstall()
    expect(fs.readFileSync(path.join(rollbackBundle, "Contents", "Info.plist"), "utf8")).toContain(VERSION_1)
    expect(fs.readFileSync(opened, "utf8")).toContain(PAGE)
  })
})
