#!/usr/bin/env bun
// Verifies the desktop artefacts electron-builder wrote to a dist directory by unpacking (or installing) each one the
// way a user would and running scripts/ci/smoke-desktop.ts against the result.
//
//   xvfb-run -a bun scripts/ci/verify_packaged.ts packages/desktop/dist     (Linux: *-unpacked, .tar.gz, .AppImage, .deb)
//   bun scripts/ci/verify_packaged.ts packages/desktop/dist                 (Windows: *-unpacked and .zip; NSIS is a separate smoke stage)
//
// Everything is unpacked under a temporary directory. NSIS install/shortcut/uninstall checks run in their own isolated smoke stage.
import { $ } from "bun"
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const dist = process.argv[2] ? path.resolve(process.argv[2]) : undefined
if (!dist) {
  console.error("usage: bun scripts/ci/verify_packaged.ts <electron-builder dist dir>")
  process.exit(2)
}

const files = await readdir(dist)
const pick = (suffix: string) => files.filter((file) => file.endsWith(suffix)).map((file) => path.join(dist, file))
const work = await mkdtemp(path.join(tmpdir(), "ezk-verify-"))
const unpacked = files
  .filter((file) => file.endsWith("-unpacked"))
  .map((file) => ({ name: file, dir: path.join(dist, file) }))

const targets =
  process.platform === "win32"
    ? [
        ...unpacked,
        ...pick(".zip").map((file) => ({ name: path.basename(file), dir: () => unzip(file) })),
      ]
    : [
        ...unpacked,
        ...pick(".tar.gz").map((file) => ({ name: path.basename(file), dir: () => untar(file) })),
        ...pick(".AppImage").map((file) => ({ name: path.basename(file), dir: () => extractAppImage(file) })),
        ...pick(".deb").map((file) => ({ name: path.basename(file), dir: () => extractDeb(file) })),
      ]

if (targets.length === 0) {
  console.error(`no desktop artefacts found in ${dist}: ${files.join(", ")}`)
  process.exit(1)
}

const failures = []
for (const target of targets) {
  console.log(`\n=== ${target.name}`)
  const dir = typeof target.dir === "string" ? target.dir : await target.dir().catch((error: unknown) => error)
  if (dir instanceof Error || typeof dir !== "string") {
    console.log(`could not unpack/install: ${dir instanceof Error ? dir.message : String(dir)}`)
    failures.push(target.name)
    continue
  }
  const code = await Bun.spawn([process.execPath, path.join(import.meta.dir, "smoke-desktop.ts"), dir], {
    stdout: "inherit",
    stderr: "inherit",
  }).exited
  if (code !== 0) failures.push(target.name)
  // An unpacked Electron app is several hundred MB and a hosted Linux runner warned of 62 MB free during this step, so drop
  // each extraction as soon as its smoke run is over instead of at the end.
  await emptyDir(work)
}
await rm(work, { recursive: true, force: true }).catch(() => {})

if (failures.length > 0) {
  console.error(`\nverify_packaged: ${failures.length}/${targets.length} artefact(s) failed: ${failures.join(", ")}`)
  process.exit(1)
}
console.log(`\nverify_packaged: all ${targets.length} artefact(s) passed`)

async function emptyDir(dir: string) {
  for (const entry of await readdir(dir).catch(() => [] as string[])) await rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => {})
}

async function untar(file: string) {
  const dest = await mkdtemp(path.join(work, "tar-"))
  await $`tar -xzf ${file} -C ${dest}`.quiet()
  return findAppDir(dest)
}

async function extractAppImage(file: string) {
  const dest = await mkdtemp(path.join(work, "appimage-"))
  await chmod(file, 0o755)
  // --appimage-extract needs no FUSE; it writes squashfs-root/ into the working directory.
  await $`${file} --appimage-extract`.cwd(dest).quiet()
  return findAppDir(dest)
}

async function extractDeb(file: string) {
  const dest = await mkdtemp(path.join(work, "deb-"))
  await $`dpkg-deb -x ${file} ${dest}`.quiet()
  return findAppDir(dest)
}

async function unzip(file: string) {
  const dest = await mkdtemp(path.join(work, "zip-"))
  await $`powershell -NoProfile -NonInteractive -Command ${`Expand-Archive -LiteralPath '${file}' -DestinationPath '${dest}'`}`.quiet()
  return findAppDir(dest)
}

// The directory holding resources/app.asar, at most three levels down (deb: opt/<Product Name>/).
async function findAppDir(root: string, depth = 0): Promise<string> {
  if (await Bun.file(path.join(root, "resources", "app.asar")).exists()) return root
  if (depth < 3) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.filter((entry) => entry.isDirectory())) {
      const found = await findAppDir(path.join(root, entry.name), depth + 1).catch(() => undefined)
      if (found) return found
    }
  }
  throw new Error(`no resources/app.asar under ${root}`)
}
