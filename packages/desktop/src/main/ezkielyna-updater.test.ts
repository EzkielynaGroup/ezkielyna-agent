import { describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FetchLike } from "../../../core/src/ezkielyna-update"
import { createVerifiedBackend, planFor, type UpdateFileSystem } from "./ezkielyna-updater"

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")
const EXE = Buffer.from("MZ-fake-installer")
const IMG = Buffer.from("AppImage-bytes")
const ZIP = Buffer.from("zip")
const VERSION = "1.20.0-ezk.1"
const latest = JSON.stringify({
  version: VERSION,
  downloads: {
    desktop: {
      "win-x64": { exe: { file: `ezkielyna-agent-${VERSION}-win-x64.exe`, sha256: sha(EXE), size: EXE.length } },
      "linux-x64": { AppImage: { file: `ezkielyna-agent-${VERSION}-linux-x64.AppImage`, sha256: sha(IMG), size: IMG.length } },
      "mac-arm64": { zip: { file: `ezkielyna-agent-${VERSION}-mac-arm64.zip`, sha256: sha("zip"), size: 3 } },
    },
    cli: {},
  },
})
const files: Record<string, Buffer | string> = {
  "latest.json": latest,
  "latest.json.sig": sign("sha256", Buffer.from(latest), { key: pair.privateKey, dsaEncoding: "der" }),
  [`ezkielyna-agent-${VERSION}-win-x64.exe`]: EXE,
  [`ezkielyna-agent-${VERSION}-linux-x64.AppImage`]: IMG,
  [`ezkielyna-agent-${VERSION}-mac-arm64.zip`]: ZIP,
}
const fetchFiles = (override: Record<string, Buffer | string> = {}): FetchLike => async (url) => {
  const body = ({ ...files, ...override } as Record<string, Buffer | string>)[decodeURIComponent(url.split("/").pop() as string)]
  return { ok: body !== undefined, status: body !== undefined ? 200 : 404, arrayBuffer: async () => new Uint8Array(Buffer.from(body ?? "")).buffer as ArrayBuffer }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ezk-upd-"))
const base = "https://ezkielyna.store/agent/update"

function backend(over: Partial<Parameters<typeof createVerifiedBackend>[0]> = {}) {
  const calls = { quit: 0, opened: [] as string[], installer: [] as { file: string; args: string[] }[], relaunch: [] as string[] }
  const b = createVerifiedBackend({
    base,
    currentVersion: "1.19.3-ezk.1",
    updatesDir: tmp(),
    pem,
    fetch: fetchFiles(),
    openExternal: (u) => calls.opened.push(u),
    quit: () => void calls.quit++,
    relaunch: (p) => calls.relaunch.push(p),
    spawnInstaller: (file, args) => calls.installer.push({ file, args }),
    platform: "win32",
    arch: "x64",
    env: {},
    ...over,
  })
  return { b, calls }
}

describe("desktop update backend", () => {
  test("Windows: verified check, hashed download, silent installer on restart", async () => {
    const { b, calls } = backend()
    expect(await b.checkForUpdates()).toEqual({ isUpdateAvailable: true, updateInfo: { version: VERSION } })
    await b.downloadUpdate()
    b.quitAndInstall()
    expect(calls.installer).toHaveLength(1)
    expect(calls.installer[0].args).toEqual(["--updated", "/S", "--force-run"])
    expect(fs.readFileSync(calls.installer[0].file)).toEqual(EXE)
    expect(calls.quit).toBe(1)
  })

  test("a tampered artifact is refused before anything is installed", async () => {
    const { b, calls } = backend({ fetch: fetchFiles({ [`ezkielyna-agent-${VERSION}-win-x64.exe`]: Buffer.from("MZ-evil-installer") }) })
    await b.checkForUpdates()
    await expect(b.downloadUpdate()).rejects.toMatchObject({ reason: "bad_hash" })
    expect(() => b.quitAndInstall()).toThrow()
    expect(calls.installer).toHaveLength(0)
  })

  test("a forged manifest is refused at the check", async () => {
    const forged = latest.replace(sha(EXE), sha("evil"))
    const { b } = backend({ fetch: fetchFiles({ "latest.json": forged }) })
    await expect(b.checkForUpdates()).rejects.toMatchObject({ reason: "bad_signature" })
  })

  test("no update when already current or when the server offers an older version", async () => {
    expect(await backend({ currentVersion: VERSION }).b.checkForUpdates()).toEqual({ isUpdateAvailable: false })
    expect(await backend({ currentVersion: "2.0.0" }).b.checkForUpdates()).toEqual({ isUpdateAvailable: false })
  })

  test("macOS outside an app bundle falls back to the verified download page", async () => {
    const { b, calls } = backend({ platform: "darwin", arch: "arm64" })
    await b.checkForUpdates()
    expect(await b.downloadUpdate()).toEqual({ installMode: "page" })
    b.quitAndInstall()
    expect(calls.installer).toHaveLength(0)
    expect(calls.opened).toEqual(["https://ezkielyna.store/agent"])
  })

  test("Linux AppImage replaces itself; other Linux installs get the page", async () => {
    const dir = tmp()
    const target = path.join(dir, "Ezkielyna.AppImage")
    fs.writeFileSync(target, "old")
    const { b, calls } = backend({ platform: "linux", env: { APPIMAGE: target } })
    await b.checkForUpdates()
    await b.downloadUpdate()
    b.quitAndInstall()
    expect(fs.readFileSync(target)).toEqual(IMG)
    expect(calls.relaunch).toEqual([target])
    const deb = backend({ platform: "linux", env: {} })
    await deb.b.checkForUpdates()
    await deb.b.downloadUpdate()
    deb.b.quitAndInstall()
    expect(deb.calls.opened).toHaveLength(1)
  })

  test("plan selection", async () => {
    const { parseManifest } = await import("../../../core/src/ezkielyna-update")
    const m = parseManifest(latest)
    expect(planFor(m, "win32", "x64", {}).kind).toBe("nsis")
    expect(planFor(m, "win32", "arm64", {}).kind).toBe("page")
    expect(planFor(m, "linux", "x64", { APPIMAGE: "/x" }).kind).toBe("appimage")
    expect(planFor(m, "darwin", "arm64", {}).kind).toBe("mac")
  })

  test("macOS rejects translocated and read-only app locations", async () => {
    for (const appPath of [
      "/private/var/folders/AppTranslocation/app/Ezkielyna Agent.app",
      "/Volumes/Installer/Ezkielyna Agent.app",
    ]) {
      const external = backend({ platform: "darwin", arch: "arm64", appPath })
      await external.b.checkForUpdates()
      expect(await external.b.downloadUpdate()).toEqual({ installMode: "page" })
    }

    const parent = tmp()
    const appPath = path.join(parent, "Ezkielyna Agent.app")
    fs.mkdirSync(appPath)
    const readonlyFs = Object.create(fs) as UpdateFileSystem
    readonlyFs.accessSync = ((target, mode) => {
      if (String(target) === parent) throw new Error("read-only parent")
      return fs.accessSync(target, mode)
    }) as typeof fs.accessSync
    const readonly = backend({ platform: "darwin", arch: "arm64", appPath, fileSystem: readonlyFs })
    await readonly.b.checkForUpdates()
    expect(await readonly.b.downloadUpdate()).toEqual({ installMode: "page" })
  })

  test("macOS rejects quarantine and writes a rollback helper for a verified bundle", async () => {
    const appPath = path.join(tmp(), "Applications", "Ezkielyna Agent.app")
    fs.mkdirSync(path.dirname(appPath), { recursive: true })
    fs.mkdirSync(appPath)
    expect({
      bundleName: appPath.endsWith(".app"),
      bundleExists: fs.existsSync(appPath),
      parentExists: fs.existsSync(path.dirname(appPath)),
      bundleSymlink: fs.lstatSync(appPath).isSymbolicLink(),
      parentWritable: (fs.statSync(path.dirname(appPath)).mode & 0o222) !== 0,
    }).toEqual({ bundleName: true, bundleExists: true, parentExists: true, bundleSymlink: false, parentWritable: true })
    const commands: string[] = []
    const command = (quarantined: boolean) => (name: string, args: string[]) => {
      const basename = path.basename(name)
      commands.push(basename)
      if (basename === "ditto") {
        const candidate = path.join(args[3], "Ezkielyna Agent.app", "Contents")
        fs.mkdirSync(candidate, { recursive: true })
        fs.writeFileSync(path.join(candidate, "Info.plist"), "fake")
        return { status: 0, stdout: "" }
      }
      if (basename === "plutil") return { status: 0, stdout: args[1] === "CFBundleIdentifier" ? "store.ezkielyna.agent" : VERSION }
      if (basename === "codesign") return { status: 0, stdout: "" }
      if (basename === "xattr") return { status: 0, stdout: quarantined ? "com.apple.quarantine" : "" }
      return { status: 1, stdout: "" }
    }

    const quarantined = backend({ platform: "darwin", arch: "arm64", appPath, runCommand: command(true) })
    await quarantined.b.checkForUpdates()
    expect(await quarantined.b.downloadUpdate()).toEqual({ installMode: "page" })

    let helper = ""
    const ready = backend({
      platform: "darwin",
      arch: "arm64",
      appPath,
      runCommand: command(false),
      spawnDetached: (_command, args) => {
        helper = fs.readFileSync(args[0], "utf8")
      },
    })
    await ready.b.checkForUpdates()
    commands.length = 0
    expect({ result: await ready.b.downloadUpdate(), commands }).toEqual({
      result: { installMode: "swap" },
      commands: ["ditto", "plutil", "plutil", "codesign", "xattr"],
    })
    ready.b.quitAndInstall()
    expect(helper).toContain('mv "$BACKUP" "$OLD_APP"')
    expect(helper).toContain("DOWNLOAD_PAGE='https://ezkielyna.store/agent'")
    expect(helper).not.toContain("xattr -d")
  })

  describe("macOS staging (round-4 M-1)", () => {
    const fakeCommands = (name: string, args: string[]) => {
      const basename = path.basename(name)
      if (basename === "ditto") {
        const candidate = path.join(args[3], "Ezkielyna Agent.app", "Contents")
        fs.mkdirSync(candidate, { recursive: true })
        fs.writeFileSync(path.join(candidate, "Info.plist"), "fake")
        return { status: 0, stdout: "" }
      }
      if (basename === "plutil") return { status: 0, stdout: args[1] === "CFBundleIdentifier" ? "store.ezkielyna.agent" : VERSION }
      return { status: 0, stdout: "" }
    }
    const setup = () => {
      const parent = path.join(tmp(), "Applications")
      const appPath = path.join(parent, "Ezkielyna Agent.app")
      fs.mkdirSync(appPath, { recursive: true })
      const updatesDir = tmp()
      return { parent, appPath, updatesDir }
    }

    test("never stages inside the folder that holds the app, and keeps exactly one stage across repeated downloads", async () => {
      const { parent, appPath, updatesDir } = setup()
      const spawned: string[][] = []
      for (let round = 0; round < 3; round++) {
        const { b } = backend({ platform: "darwin", arch: "arm64", appPath, updatesDir, runCommand: fakeCommands, spawnDetached: (_c, args) => void spawned.push(args) })
        await b.checkForUpdates()
        expect(await b.downloadUpdate()).toEqual({ installMode: "swap" })
      }
      expect(fs.readdirSync(parent)).toEqual(["Ezkielyna Agent.app"])
      expect(fs.readdirSync(updatesDir).filter((name) => name.startsWith("stage-"))).toHaveLength(1)
    })

    test("start-up cleanup removes stale stages (ours and the legacy ones beside the app) and never follows a symlink", () => {
      const { parent, appPath, updatesDir } = setup()
      const outside = tmp()
      fs.writeFileSync(path.join(outside, "keep.txt"), "x")
      for (const dir of [path.join(updatesDir, "stage-abc123"), path.join(parent, ".ezk-update-xyz789"), path.join(parent, ".ezk-new-4242.app")]) {
        fs.mkdirSync(path.join(dir, "inner"), { recursive: true })
      }
      fs.mkdirSync(path.join(updatesDir, "stage-keepme-not-a-stage"))
      fs.symlinkSync(outside, path.join(updatesDir, "stage-link123"))
      const { b } = backend({ platform: "darwin", arch: "arm64", appPath, updatesDir })
      b.cleanup?.()
      expect(fs.readdirSync(parent).sort()).toEqual(["Ezkielyna Agent.app"])
      expect(fs.readdirSync(updatesDir).sort()).toEqual(["stage-keepme-not-a-stage", "stage-link123"])
      expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("x")
    })

    test("the helper copies and re-verifies the staged app before the swap, takes a lock, and runs once per update", async () => {
      const { appPath, updatesDir } = setup()
      const scripts: string[] = []
      const { b } = backend({ platform: "darwin", arch: "arm64", appPath, updatesDir, runCommand: fakeCommands, spawnDetached: (_c, args) => void scripts.push(fs.readFileSync(args[0], "utf8")) })
      await b.checkForUpdates()
      await b.downloadUpdate()
      b.quitAndInstall()
      b.quitAndInstall() // a second Restart click
      expect(scripts).toHaveLength(1)
      const helper = scripts[0]!
      expect(helper).toContain('/bin/mkdir "$STAGE/lock" 2>/dev/null || exit 0')
      expect(helper).toContain('/usr/bin/ditto "$NEW_APP" "$SWAP_TEMP"')
      expect(helper).toContain('/usr/bin/codesign --verify --deep "$SWAP_TEMP"')
      expect(helper).toContain('/bin/mv "$SWAP_TEMP" "$OLD_APP"')
      expect(helper.indexOf('/usr/bin/codesign --verify --deep "$SWAP_TEMP"')).toBeLessThan(helper.indexOf('/bin/mv "$OLD_APP" "$BACKUP"'))
      expect(helper).not.toContain(".ezk-update-")
      expect(helper).not.toContain("xattr -d")
    })
  })

  test("insecure or foreign update URLs are rejected", async () => {
    await expect(backend({ base: "http://ezkielyna.store/agent/update" }).b.checkForUpdates()).rejects.toMatchObject({ reason: "insecure_url" })
    await expect(backend({ base: "https://example.com/agent/update" }).b.checkForUpdates()).rejects.toMatchObject({ reason: "bad_host" })
  })

  test("fallback opens the signed beta download page when supplied", async () => {
    const body = JSON.stringify({ ...JSON.parse(latest), downloadPage: "https://ezkielyna.store/agent/beta" })
    const signature = sign("sha256", Buffer.from(body), { key: pair.privateKey, dsaEncoding: "der" })
    const { b, calls } = backend({
      platform: "linux",
      env: {},
      fetch: fetchFiles({ "latest.json": body, "latest.json.sig": signature }),
    })
    await b.checkForUpdates()
    await b.downloadUpdate()
    b.quitAndInstall()
    expect(calls.opened).toEqual(["https://ezkielyna.store/agent/beta"])
  })
})
