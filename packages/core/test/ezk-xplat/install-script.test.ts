import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const script = fs.readFileSync(path.resolve(import.meta.dir, "../../../../install.ps1"), "utf8")
const shellScript = fs.readFileSync(path.resolve(import.meta.dir, "../../../../install"), "utf8")

describe("Windows installer security and path handling", () => {
  test("uses current-user Local AppData and only updates the user PATH", () => {
    expect(script).toContain("$env:LOCALAPPDATA")
    expect(script).toContain("GetFolderPath('LocalApplicationData')")
    expect(script).toContain("SetEnvironmentVariable('Path',")
    expect(script).toContain("'User')")
    expect(script).toContain("$env:PROCESSOR_ARCHITEW6432")
  })

  test("verifies signed metadata and archive hashes before extraction", () => {
    expect(script).toContain("Assert-Signature $Manifest")
    expect(script).toContain("Assert-Signature $Checksums")
    expect(script.indexOf("Get-FileHash")).toBeLessThan(script.indexOf("Expand-Archive"))
    expect(script).toContain("ExecutionPolicy Bypass")
  })

  test("keeps the signature verification in front of every install step", () => {
    expect(script.match(/\$PubB64 = '/g)?.length).toBe(1)
    expect(script).toContain("VerifyData(")
    expect(script).toContain("refusing to install")
    const verify = script.indexOf("Assert-Signature $Checksums $ChecksumsSignature")
    expect(verify).toBeGreaterThan(-1)
    for (const step of ["Get-ReleaseFile $ArchiveName", "Expand-Archive", "Copy-Item -LiteralPath $Executable", "SetEnvironmentVariable('Path',"]) {
      // the -Uninstall path legitimately edits PATH before any download, so check the last (install) occurrence
      expect(script.lastIndexOf(step)).toBeGreaterThan(verify)
    }
  })

  // Windows PowerShell 5.1 draws a progress bar per chunk of Invoke-WebRequest, which made the ~60 MB archive take longer than the
  // Windows CI smoke allowed. `irm | iex` runs in the caller's scope, so the caller's value has to come back afterwards.
  test("silences the progress bar while installing and restores the caller's value", () => {
    const set = script.indexOf("$ProgressPreference = 'SilentlyContinue'")
    expect(set).toBeGreaterThan(script.indexOf("$PreviousProgress = $ProgressPreference"))
    expect(set).toBeLessThan(script.indexOf("Get-ReleaseFile 'latest.json'"))
    expect(script.slice(script.lastIndexOf("} finally {"))).toContain("$ProgressPreference = $PreviousProgress")
  })

  // ForEach-Object / function output is unrolled: piping the 4-number keys through it left loose numbers, so 1.19.3-ezk.2 -> 1.19.3-ezk.5
  // compared 19 against 1 and was refused as a downgrade. The keys are collected in a list with Add instead.
  test("keeps each version key an array for the no-downgrade comparison", () => {
    expect(script).not.toMatch(/ForEach-Object\s*\{\s*ConvertTo-VersionKey/)
    expect(script).toContain("[void]$InstalledNow.Add($key)")
  })

  test("uses a per-run temporary directory and cleans it after errors", () => {
    expect(script).toContain("[Guid]::NewGuid()")
    expect(script).toContain("finally {")
    expect(script).toContain("Remove-Item -LiteralPath $Temp")
  })

  test("Linux installer chmods the CLI and only runs xattr on macOS", () => {
    expect(shellScript).toContain('chmod +x "$dest/ezkielyna"')
    expect(shellScript).toContain('[ "$os" != darwin ] || xattr -dr com.apple.quarantine')
  })
})
