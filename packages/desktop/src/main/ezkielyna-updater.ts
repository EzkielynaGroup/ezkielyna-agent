// Ezkielyna Agent: updates are offered only after the signed manifest and artifact hashes verify.
// macOS swaps only an ad-hoc-signed bundle in a writable, non-translocated location; all other installs use its signed page.
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { EZK } from "../../../core/src/ezkielyna-brand"
import {
  UpdateRejected,
  fetchVerifiedManifest,
  verifyBytes,
  type ArtifactInfo,
  type FetchLike,
  type Manifest,
} from "../../../core/src/ezkielyna-update"
import type { UpdaterBackend } from "./updater-controller"

export type InstallPlan =
  | { kind: "nsis"; artifact: ArtifactInfo }
  | { kind: "appimage"; artifact: ArtifactInfo }
  | { kind: "mac"; artifact: ArtifactInfo; downloadPage: string }
  | { kind: "page"; downloadPage: string }

const fallbackPage = (manifest: Manifest) => manifest.downloadPage ?? `${EZK.storeURL}/agent`

export function planFor(manifest: Manifest, platform: NodeJS.Platform, arch: string, env: Record<string, string | undefined>): InstallPlan {
  const a = arch === "arm64" ? "arm64" : "x64"
  if (platform === "win32") {
    const exe = manifest.downloads.desktop[`win-${a}`]?.exe
    if (exe) return { kind: "nsis", artifact: exe }
  }
  if (platform === "linux" && env.APPIMAGE) {
    const image = manifest.downloads.desktop[`linux-${a}`]?.AppImage
    if (image) return { kind: "appimage", artifact: image }
  }
  if (platform === "darwin") {
    const zip = manifest.downloads.desktop[`mac-${a}`]?.zip
    if (zip) return { kind: "mac", artifact: zip, downloadPage: fallbackPage(manifest) }
  }
  return { kind: "page", downloadPage: fallbackPage(manifest) }
}

export type UpdateFileSystem = Pick<
  typeof fs,
  | "constants"
  | "accessSync"
  | "existsSync"
  | "lstatSync"
  | "statSync"
  | "mkdtempSync"
  | "mkdirSync"
  | "writeFileSync"
  | "copyFileSync"
  | "renameSync"
  | "chmodSync"
  | "readdirSync"
  | "rmSync"
>

type CommandResult = { status: number | null; stdout: string; stderr?: string }
type CommandRunner = (command: string, args: string[]) => CommandResult
type DetachedRunner = (command: string, args: string[], env?: NodeJS.ProcessEnv) => void

type PreparedMacUpdate = { helper: string }
type DownloadedUpdate = { file: string; plan: InstallPlan; preparedMac?: PreparedMacUpdate }

export type VerifiedBackendInput = {
  base: string
  currentVersion: string
  updatesDir: string
  platform?: NodeJS.Platform
  arch?: string
  env?: Record<string, string | undefined>
  fetch?: FetchLike
  openExternal: (url: string) => void
  quit: () => void
  relaunch?: (execPath: string) => void
  spawnInstaller?: (file: string, args: string[]) => void
  pem?: string
  hosts?: readonly string[]
  appPath?: string
  appPid?: number
  homeDir?: string
  openCommand?: string
  waitTimeoutSeconds?: number
  fileSystem?: UpdateFileSystem
  runCommand?: CommandRunner
  spawnDetached?: DetachedRunner
}

export function createVerifiedBackend(input: VerifiedBackendInput): UpdaterBackend {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const env = input.env ?? process.env
  const io = input.fileSystem ?? fs
  const f = input.fetch ?? (fetch as unknown as FetchLike)
  const runCommand = input.runCommand ?? ((command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  })
  const spawnDetached = input.spawnDetached ?? ((command, args, childEnv) => {
    void spawn(command, args, { detached: true, stdio: "ignore", env: childEnv }).unref()
  })
  let latest: { manifest: Manifest; base: string } | undefined
  let downloaded: DownloadedUpdate | undefined
  let installing = false
  const macAppPath = () => input.appPath ?? path.resolve(process.execPath, "../../..")

  return {
    /** Called once at start: removes staging folders left behind by earlier runs (never the one of this session). */
    cleanup() {
      if (platform === "darwin") cleanStaleStages(io, input.updatesDir, macAppPath())
    },
    async checkForUpdates() {
      try {
        latest = await fetchVerifiedManifest({ base: input.base, currentVersion: input.currentVersion, fetch: f, pem: input.pem, hosts: input.hosts })
        return { isUpdateAvailable: true, updateInfo: { version: latest.manifest.version } }
      } catch (error) {
        if (error instanceof UpdateRejected && error.reason === "not_newer") return { isUpdateAvailable: false }
        throw error
      }
    },
    async downloadUpdate() {
      if (!latest) throw new UpdateRejected("bad_manifest", "no verified update to download")
      const plan = planFor(latest.manifest, platform, arch, env)
      if (plan.kind === "page") {
        downloaded = { file: "", plan }
        return { installMode: "page" as const }
      }
      const url = `${latest.base}/${encodeURIComponent(plan.artifact.file)}`
      const res = await f(url, { redirect: "error" })
      if (!res.ok) throw new UpdateRejected("fetch_failed", `${url} answered ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      verifyBytes(bytes, plan.artifact)
      io.mkdirSync(input.updatesDir, { recursive: true, mode: 0o700 })
      const file = path.join(input.updatesDir, plan.artifact.file)
      io.writeFileSync(file, bytes, { mode: plan.kind === "appimage" ? 0o755 : 0o600 })
      if (plan.kind !== "mac") {
        downloaded = { file, plan }
        return { installMode: "swap" as const }
      }
      const preparedMac = prepareMacUpdate({
        updatesDir: input.updatesDir,
        appPath: macAppPath(),
        appPid: input.appPid ?? process.pid,
        homeDir: input.homeDir ?? env.HOME ?? process.env.HOME ?? "",
        openCommand: input.openCommand ?? "/usr/bin/open",
        waitTimeoutSeconds: input.waitTimeoutSeconds ?? 120,
        file,
        version: latest.manifest.version,
        downloadPage: plan.downloadPage,
        io,
        runCommand,
      })
      downloaded = { file, plan, preparedMac }
      return { installMode: preparedMac ? ("swap" as const) : ("page" as const) }
    },
    quitAndInstall() {
      if (!downloaded) throw new UpdateRejected("bad_file", "update was not downloaded")
      const { file, plan } = downloaded
      if (plan.kind === "nsis") {
        const run = input.spawnInstaller ?? ((exe, args) => void spawn(exe, args, { detached: true, stdio: "ignore" }).unref())
        run(file, ["--updated", "/S", "--force-run"])
        input.quit()
        return
      }
      if (plan.kind === "appimage") {
        const target = env.APPIMAGE as string
        io.copyFileSync(file, `${target}.new`)
        io.chmodSync(`${target}.new`, 0o755)
        io.renameSync(`${target}.new`, target)
        input.relaunch?.(target)
        input.quit()
        return
      }
      if (plan.kind === "mac" && downloaded.preparedMac) {
        if (installing) return // a second Restart click while the first helper is already waiting for this process to exit
        installing = true
        const childEnv = { ...process.env, ...env }
        spawnDetached("/bin/sh", [downloaded.preparedMac.helper], childEnv)
        input.quit()
        return
      }
      input.openExternal(plan.downloadPage)
      input.quit()
    },
  }
}

const STAGE_DIR = /^stage-[A-Za-z0-9]{6}$/
const LEGACY_STAGE_DIR = /^\.ezk-update-[A-Za-z0-9]{6}$/ // earlier builds staged the update next to the app, inside /Applications
const SWAP_TEMP_DIR = /^\.ezk-new-\d+\.app$/ // the helper's copy next to the app, normally gone again after the swap

/** Remove leftover staging folders: ours under the updates dir, plus legacy/temporary ones next to the app. Symlinks are never followed. */
export function cleanStaleStages(io: UpdateFileSystem, updatesDir: string, appPath: string) {
  const sweep = (dir: string, patterns: RegExp[]) => {
    let entries: fs.Dirent[]
    try {
      entries = io.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !patterns.some((pattern) => pattern.test(entry.name))) continue
      try {
        io.rmSync(path.join(dir, entry.name), { recursive: true, force: true })
      } catch {}
    }
  }
  sweep(updatesDir, [STAGE_DIR])
  sweep(path.dirname(path.resolve(appPath)), [LEGACY_STAGE_DIR, SWAP_TEMP_DIR])
}

function prepareMacUpdate(input: {
  updatesDir: string
  appPath: string
  appPid: number
  homeDir: string
  openCommand: string
  waitTimeoutSeconds: number
  file: string
  version: string
  downloadPage: string
  io: UpdateFileSystem
  runCommand: CommandRunner
}): PreparedMacUpdate | undefined {
  const { io } = input
  const command = (executable: string, args: string[]) => {
    try {
      return input.runCommand(executable, args)
    } catch {
      return { status: null, stdout: "", stderr: "" }
    }
  }
  if (!input.homeDir || !path.isAbsolute(input.homeDir)) return
  const appPath = path.resolve(input.appPath)
  if (!appPath.endsWith(".app") || appPath.includes("/Volumes/") || appPath.toLowerCase().includes("apptranslocation")) return
  if (!io.existsSync(appPath) || !io.existsSync(path.dirname(appPath))) return
  try {
    if (io.lstatSync(appPath).isSymbolicLink()) return
    const parent = path.dirname(appPath)
    if (!(io.statSync(parent).mode & 0o222)) return
    io.accessSync(parent, io.constants.W_OK)
  } catch {
    return
  }

  // The staged copy lives in the private updates folder, never in /Applications (which is shared with other admin users and is where
  // an unfinished update used to leave hundreds of MB). The helper copies it next to the app only for the moment of the swap.
  cleanStaleStages(io, input.updatesDir, appPath)
  io.mkdirSync(input.updatesDir, { recursive: true, mode: 0o700 })
  const stage = io.mkdtempSync(path.join(input.updatesDir, "stage-"))
  const unpacked = path.join(stage, "unpacked")
  io.mkdirSync(unpacked, { recursive: true, mode: 0o700 })
  const fail = () => {
    try {
      io.rmSync(stage, { recursive: true, force: true })
    } catch {}
    return undefined
  }
  if (command("/usr/bin/ditto", ["-x", "-k", input.file, unpacked]).status !== 0) return fail()
  const candidate = findAppBundle(unpacked, io)
  if (!candidate) return fail()
  const info = path.join(candidate, "Contents", "Info.plist")
  const identifier = command("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", info])
  const version = command("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", info])
  if (identifier.status !== 0 || identifier.stdout.trim() !== "store.ezkielyna.agent") return fail()
  if (version.status !== 0 || version.stdout.trim() !== input.version) return fail()
  if (command("/usr/bin/codesign", ["--verify", "--deep", candidate]).status !== 0) return fail()
  const attributes = command("/usr/bin/xattr", ["-lr", candidate])
  if (attributes.status !== 0 || `${attributes.stdout}\n${attributes.stderr ?? ""}`.includes("com.apple.quarantine")) return fail()

  const helper = path.join(stage, "install-update.sh")
  io.writeFileSync(helper, macInstallHelper({
    oldApp: appPath,
    newApp: candidate,
    stage,
    backupRoot: path.join(input.homeDir, "Library", "Application Support", "ezkielyna", "app-backup"),
    openCommand: input.openCommand,
    downloadPage: input.downloadPage,
    appPid: input.appPid,
    version: input.version,
    waitTimeoutSeconds: input.waitTimeoutSeconds,
    swapTemp: path.join(path.dirname(appPath), `.ezk-new-${input.appPid}.app`),
  }), { mode: 0o700 })
  io.chmodSync(helper, 0o700)
  return { helper }
}

function findAppBundle(root: string, io: UpdateFileSystem, depth = 0): string | undefined {
  if (depth > 5) return
  for (const entry of io.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const target = path.join(root, entry.name)
    if (entry.name.endsWith(".app")) return target
    const nested = findAppBundle(target, io, depth + 1)
    if (nested) return nested
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function macInstallHelper(input: {
  oldApp: string
  newApp: string
  stage: string
  backupRoot: string
  openCommand: string
  downloadPage: string
  appPid: number
  version: string
  waitTimeoutSeconds: number
  /** Copy of the new app next to the old one, so the final rename stays on one volume (and is atomic). */
  swapTemp: string
}) {
  const backup = path.join(input.backupRoot, "Ezkielyna Agent.app")
  const previous = path.join(input.backupRoot, `.previous-${input.appPid}.app`)
  return `#!/bin/sh
set -u
OLD_APP=${shellQuote(input.oldApp)}
NEW_APP=${shellQuote(input.newApp)}
STAGE=${shellQuote(input.stage)}
BACKUP_ROOT=${shellQuote(input.backupRoot)}
OPEN_COMMAND=${shellQuote(input.openCommand)}
BACKUP=${shellQuote(backup)}
PREVIOUS=${shellQuote(previous)}
DOWNLOAD_PAGE=${shellQuote(input.downloadPage)}
APP_PID=${shellQuote(String(input.appPid))}
WAIT_SECONDS=${shellQuote(String(input.waitTimeoutSeconds))}
SWAP_TEMP=${shellQuote(input.swapTemp)}
EXPECTED_ID='store.ezkielyna.agent'
EXPECTED_VERSION=${shellQuote(input.version)}
NEW_INSTALLED=0

# A second helper for the same update (a double click on Restart) must not race this one over the backup folders.
/bin/mkdir "$STAGE/lock" 2>/dev/null || exit 0

fallback() {
  /bin/rm -rf "$SWAP_TEMP"
  if [ "$NEW_INSTALLED" -eq 1 ]; then /bin/rm -rf "$OLD_APP"; fi
  if [ ! -e "$OLD_APP" ] && [ -e "$BACKUP" ]; then /bin/mv "$BACKUP" "$OLD_APP" || true; fi
  if [ -e "$PREVIOUS" ] && [ ! -e "$BACKUP" ]; then /bin/mv "$PREVIOUS" "$BACKUP" || true; fi
  if [ -e "$OLD_APP" ]; then "$OPEN_COMMAND" "$OLD_APP" >/dev/null 2>&1 || true; fi
  "$OPEN_COMMAND" "$DOWNLOAD_PAGE" >/dev/null 2>&1 || true
  /bin/rm -rf "$STAGE"
  exit 1
}

# Copy the staged app next to the old one and verify the COPY right before the swap (the staged files may be days old).
/bin/rm -rf "$SWAP_TEMP"
/usr/bin/ditto "$NEW_APP" "$SWAP_TEMP" || fallback
[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$SWAP_TEMP/Contents/Info.plist" 2>/dev/null)" = "$EXPECTED_ID" ] || fallback
[ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$SWAP_TEMP/Contents/Info.plist" 2>/dev/null)" = "$EXPECTED_VERSION" ] || fallback
/usr/bin/codesign --verify --deep "$SWAP_TEMP" >/dev/null 2>&1 || fallback
if /usr/bin/xattr -lr "$SWAP_TEMP" 2>/dev/null | /usr/bin/grep -q com.apple.quarantine; then fallback; fi

elapsed=0
while /bin/kill -0 "$APP_PID" 2>/dev/null; do
  [ "$elapsed" -lt "$WAIT_SECONDS" ] || fallback
  /bin/sleep 1
  elapsed=$((elapsed + 1))
done

/bin/mkdir -p "$BACKUP_ROOT" || fallback
if [ -e "$BACKUP" ]; then /bin/mv "$BACKUP" "$PREVIOUS" || fallback; fi
/bin/mv "$OLD_APP" "$BACKUP" || fallback
/bin/mv "$SWAP_TEMP" "$OLD_APP" || fallback
NEW_INSTALLED=1
"$OPEN_COMMAND" "$OLD_APP" >/dev/null 2>&1 || fallback
/bin/rm -rf "$PREVIOUS"
/bin/rm -rf "$STAGE"
exit 0
`
}
