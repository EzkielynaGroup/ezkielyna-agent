// C3 `ezkielyna uninstall`: the plan (what is removed, what is left alone) and its execution against a throwaway home folder.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describePlan, executePlan, planUninstall, purgeDirsOf, removeFromWindowsPath, safeToRemove, stripInstallerBlock } from "../../src/ezk/uninstall"

const made: string[] = []
afterEach(() => made.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

/** A fake home with an install, shell profiles and app folders; returns the paths. */
function home() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-uninstall-")))
  made.push(dir)
  const put = (rel: string, text = "x") => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  put(".ezkielyna/bin/ezkielyna")
  put(".ezkielyna/versions/1.0.0/ezkielyna")
  const bin = path.join(dir, ".ezkielyna", "bin")
  // exactly what install.sh appends: printf '\n# Ezkielyna Agent\n%s\n' 'export PATH="<bin>:$PATH"'
  const block = `\n# Ezkielyna Agent\nexport PATH="${bin}:$PATH"\n`
  put(".zshrc", `export EDITOR=vim\n${block}alias ll='ls -l'\n`)
  put(".bashrc", `# my bashrc\n${block}`)
  put(".config/ezkielyna/ezkielyna.json", "{}")
  put(".local/share/ezkielyna/auth.json", "{}")
  put(".local/state/ezkielyna/s", "x")
  put(".cache/ezkielyna/c", "x")
  // neighbours that must survive
  put(".config/other-app/keep", "x")
  put(".config/ezkielyna-other/keep", "x")
  put(".local/share/ezkielyna-backup/keep", "x")
  return { dir, bin, block, put, env: { HOME: dir } as Record<string, string | undefined> }
}

describe("stripInstallerBlock", () => {
  test("removes the block the installer appended, and the blank line before it, nothing else", () => {
    const bin = "/home/u/.ezkielyna/bin"
    const text = `export A=1\n\n# Ezkielyna Agent\nexport PATH="${bin}:$PATH"\nexport B=2\n`
    expect(stripInstallerBlock(text, bin)).toEqual({ text: "export A=1\nexport B=2\n", removed: ["# Ezkielyna Agent", `export PATH="${bin}:$PATH"`] })
  })

  test("is a no-op when the block is gone, and does not touch a PATH line the user wrote", () => {
    const bin = "/home/u/.ezkielyna/bin"
    const own = `export PATH="${bin}:$PATH"\n`
    expect(stripInstallerBlock(own, bin)).toEqual({ text: own, removed: [] })
    const other = `# Ezkielyna Agent\nexport PATH="/somewhere/else:$PATH"\n`
    expect(stripInstallerBlock(other, bin).removed).toEqual([])
    const once = stripInstallerBlock(`a\n\n# Ezkielyna Agent\nexport PATH="${bin}:$PATH"\n`, bin).text
    expect(stripInstallerBlock(once, bin).removed).toEqual([])
  })

  test("also removes a block that used $HOME and Windows line endings", () => {
    const text = `a\r\n\r\n# Ezkielyna Agent\r\nexport PATH="$HOME/.ezkielyna/bin:$PATH"\r\nb\r\n`
    expect(stripInstallerBlock(text, "/x/.ezkielyna/bin").text).toBe("a\r\nb\r\n")
  })
})

describe("plan", () => {
  test("default: the install folder and the installer's PATH lines; settings and sign-in are kept and said so", () => {
    const h = home()
    const plan = planUninstall({ platform: "linux", home: h.dir, env: h.env, purge: false, lang: "en" })
    expect(plan.trashDir).toBeUndefined()
    expect(plan.items.map((i) => (i.kind === "dir" || i.kind === "profile" ? i.path : i.kind))).toEqual([path.join(h.dir, ".ezkielyna"), path.join(h.dir, ".zshrc"), path.join(h.dir, ".bashrc")])
    expect(plan.notes.join("\n")).toContain("--purge")
    const text = describePlan(plan, "en")
    expect(text).toContain(path.join(h.dir, ".ezkielyna"))
    expect(text).toContain("deleted")
    expect(text).not.toContain(".config/ezkielyna")
  })

  test("--purge adds exactly the four app folders and the keychain entry", () => {
    const h = home()
    const plan = planUninstall({ platform: "linux", home: h.dir, env: h.env, purge: true, lang: "en" })
    const dirs = plan.items.filter((i) => i.kind === "dir").map((i) => (i as { path: string }).path)
    expect(dirs).toEqual([".ezkielyna", ".config/ezkielyna", ".local/share/ezkielyna", ".local/state/ezkielyna", ".cache/ezkielyna"].map((rel) => path.join(h.dir, rel)))
    expect(plan.items.some((i) => i.kind === "keychain")).toBe(true)
    expect(purgeDirsOf({ home: h.dir, env: { XDG_CONFIG_HOME: "/custom/cfg" } })[0]).toBe("/custom/cfg/ezkielyna")
  })

  test("macOS plans the Trash; Linux and Windows do not", () => {
    const h = home()
    expect(planUninstall({ platform: "darwin", home: h.dir, env: h.env, purge: false }).trashDir).toBe(path.join(h.dir, ".Trash"))
    expect(planUninstall({ platform: "linux", home: h.dir, env: h.env, purge: false }).trashDir).toBeUndefined()
  })

  test("never plans to delete the home folder, a parent of it or the root, whatever EZK_INSTALL_DIR says", () => {
    const h = home()
    for (const bad of [h.dir, path.dirname(h.dir), "/"]) {
      const plan = planUninstall({ platform: "linux", home: h.dir, env: { ...h.env, EZK_INSTALL_DIR: bad }, purge: false, lang: "en", exists: () => true })
      expect(plan.items.filter((i) => i.kind === "dir")).toEqual([])
      expect(plan.notes.join(" ")).toContain("Refusing")
    }
    expect(safeToRemove(path.join(h.dir, ".ezkielyna"), h.dir)).toBe(true)
  })

  test("nothing installed: says so and plans nothing", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-uninstall-empty-")))
    made.push(dir)
    const plan = planUninstall({ platform: "linux", home: dir, env: { HOME: dir }, purge: false, lang: "en" })
    expect(plan.items).toEqual([])
    expect(plan.notes[0]).toContain("No Ezkielyna Agent install found")
  })

  test("a PATH line the installer did not write is reported, not removed", () => {
    const h = home()
    h.put(".bash_profile", `export PATH="${h.bin}:$PATH"\n`)
    const plan = planUninstall({ platform: "linux", home: h.dir, env: h.env, purge: false, lang: "en" })
    expect(plan.items.some((i) => i.kind === "profile" && i.path.endsWith(".bash_profile"))).toBe(false)
    expect(plan.notes.join("\n")).toContain(".bash_profile has a PATH line")
  })

  test("Indonesian text", () => {
    const h = home()
    expect(describePlan(planUninstall({ platform: "linux", home: h.dir, env: h.env, purge: false, lang: "id" }), "id")).toContain("Ezkielyna Agent akan menghapus:")
  })
})

describe("execute (Linux: deletes only the listed paths)", () => {
  test("default run removes the install folder and the PATH lines; settings, sign-in and neighbours stay", () => {
    const h = home()
    const log: string[] = []
    const failures = executePlan(planUninstall({ platform: "linux", home: h.dir, env: h.env, purge: false, lang: "en" }), { log: (l) => log.push(l) })
    expect(failures).toBe(0)
    expect(fs.existsSync(path.join(h.dir, ".ezkielyna"))).toBe(false)
    expect(fs.readFileSync(path.join(h.dir, ".zshrc"), "utf8")).toBe("export EDITOR=vim\nalias ll='ls -l'\n")
    expect(fs.readFileSync(path.join(h.dir, ".bashrc"), "utf8")).toBe("# my bashrc\n")
    for (const kept of [".config/ezkielyna/ezkielyna.json", ".local/share/ezkielyna/auth.json", ".local/state/ezkielyna/s", ".cache/ezkielyna/c"]) expect(fs.existsSync(path.join(h.dir, kept))).toBe(true)
    expect(log.some((l) => l.startsWith("Deleted:"))).toBe(true)
  })

  test("--purge removes the four folders and no neighbour", () => {
    const h = home()
    let secretDeleted = 0
    executePlan(planUninstall({ platform: "linux", home: h.dir, env: h.env, purge: true, lang: "en" }), { log: () => {}, deleteSecret: () => void secretDeleted++ })
    for (const gone of [".ezkielyna", ".config/ezkielyna", ".local/share/ezkielyna", ".local/state/ezkielyna", ".cache/ezkielyna"]) expect(fs.existsSync(path.join(h.dir, gone))).toBe(false)
    for (const kept of [".config/other-app/keep", ".config/ezkielyna-other/keep", ".local/share/ezkielyna-backup/keep"]) expect(fs.existsSync(path.join(h.dir, kept))).toBe(true)
    expect(secretDeleted).toBe(1)
  })

  test("a symlinked install folder: the link goes, its target stays", () => {
    const h = home()
    const real = path.join(h.dir, "elsewhere")
    fs.renameSync(path.join(h.dir, ".ezkielyna"), real)
    fs.symlinkSync(real, path.join(h.dir, ".ezkielyna"))
    executePlan(planUninstall({ platform: "linux", home: h.dir, env: h.env, purge: false }), { log: () => {} })
    expect(fs.existsSync(path.join(h.dir, ".ezkielyna"))).toBe(false)
    expect(fs.existsSync(path.join(real, "bin", "ezkielyna"))).toBe(true)
  })

  test("a failure on one item is reported and the others still run", () => {
    const h = home()
    const log: string[] = []
    const failures = executePlan(planUninstall({ platform: "linux", home: h.dir, env: h.env, purge: false, lang: "en" }), {
      log: (l) => log.push(l),
      remove: () => {
        throw new Error("EACCES")
      },
    })
    expect(failures).toBe(1)
    expect(log.join("\n")).toContain("Could not remove")
    expect(fs.readFileSync(path.join(h.dir, ".bashrc"), "utf8")).toBe("# my bashrc\n")
  })
})

describe("execute (macOS: the Trash)", () => {
  test("folders are moved to ~/.Trash, with a numbered name when it is taken", () => {
    const h = home()
    h.put(".Trash/ezkielyna/old", "x")
    const log: string[] = []
    executePlan(planUninstall({ platform: "darwin", home: h.dir, env: h.env, purge: true, lang: "en" }), { log: (l) => log.push(l), deleteSecret: () => {} })
    expect(fs.existsSync(path.join(h.dir, ".ezkielyna"))).toBe(false)
    expect(fs.existsSync(path.join(h.dir, ".Trash", "ezkielyna 2", "bin", "ezkielyna"))).toBe(true)
    expect(fs.existsSync(path.join(h.dir, ".Trash", "ezkielyna", "old"))).toBe(true)
    expect(log.some((l) => l.startsWith("Moved to the Trash:"))).toBe(true)
    expect(describePlan(planUninstall({ platform: "darwin", home: h.dir, env: h.env, purge: false }), "en")).toBeTypeOf("string")
  })
})

describe("Windows", () => {
  test("the user PATH loses only the install bin folder (case and trailing slash ignored)", () => {
    expect(removeFromWindowsPath("C:\\Tools;C:\\Users\\me\\AppData\\Local\\Ezkielyna\\bin\;C:\\Other", "c:\\users\\me\\appdata\\local\\ezkielyna\\bin")).toEqual({ value: "C:\\Tools;C:\\Other", removed: true })
    expect(removeFromWindowsPath("C:\\Tools", "C:\\x\\bin")).toEqual({ value: "C:\\Tools", removed: false })
  })

  test("plan and execution: PATH entry removed, folder deleted after exit, nothing else", () => {
    const h = home()
    const installDir = path.join(h.dir, "AppData", "Local", "Ezkielyna")
    fs.mkdirSync(path.join(installDir, "bin"), { recursive: true })
    const plan = planUninstall({ platform: "win32", home: h.dir, env: { LOCALAPPDATA: path.join(h.dir, "AppData", "Local") }, purge: false, lang: "en" })
    expect(plan.items.map((i) => i.kind)).toEqual(["dir", "winpath"])
    const written: string[] = []
    const later: string[] = []
    const bin = path.join(installDir, "bin")
    executePlan(plan, { log: () => {}, readUserPath: () => `C:\\Tools;${bin}`, writeUserPath: (v) => void written.push(v), removeAfterExit: (d) => void later.push(d) })
    expect(written).toEqual(["C:\\Tools"])
    expect(later).toEqual([installDir])
    expect(fs.existsSync(installDir)).toBe(true) // removed by the helper after this process exits
  })
})
