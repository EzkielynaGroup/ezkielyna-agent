<#
Ezkielyna Agent CLI installer for Windows (PowerShell 5.1+). No administrator access is required, nothing needs to be installed first.

  irm https://ezkielyna.store/agent/install.ps1 | iex
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Version V] [-Local C:\release\files] [-NoModifyPath]

The offline ECDSA P-256 signature of latest.json and SHA256SUMS and the SHA-256 of the archive are verified (with .NET, no OpenSSL
needed) BEFORE anything is extracted. Files go to %LOCALAPPDATA%\Ezkielyna (versions\<v>\ezkielyna.exe, bin\ezkielyna.cmd and bin\ezk.cmd)
and only the current user's PATH is changed. An upstream OpenCode install is never touched.
Environment: VERSION, EZK_BASE_URL (default https://ezkielyna.store/agent/update), EZK_ALLOW_DOWNGRADE=1 to install an older signed release.

To uninstall, close any running ezkielyna.exe process, then remove the per-user CLI files and PATH entry in PowerShell:
  $root = Join-Path $env:LOCALAPPDATA 'Ezkielyna'; $bin = Join-Path $root 'bin'
  $path = [Environment]::GetEnvironmentVariable('Path','User')
  [Environment]::SetEnvironmentVariable('Path', (($path -split ';' | Where-Object { $_ -and $_.TrimEnd([char]92).ToLowerInvariant() -ne $bin.TrimEnd([char]92).ToLowerInvariant() }) -join ';'), 'User')
  Remove-Item -LiteralPath $root -Recurse -Force
#>
[CmdletBinding()]
param([string]$Local = "", [string]$Version = $env:VERSION, [switch]$NoModifyPath)

$ErrorActionPreference = 'Stop'
$Base = if ($env:EZK_BASE_URL) { $env:EZK_BASE_URL.TrimEnd('/') } else { 'https://ezkielyna.store/agent/update' }
$LocalData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('LocalApplicationData') }
if (-not $LocalData) { throw 'Could not locate the current user Local AppData directory.' }
$InstallRoot = Join-Path $LocalData 'Ezkielyna'
$Bin = Join-Path $InstallRoot 'bin'
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('ezk-install-' + [Guid]::NewGuid().ToString('N'))
$ArchName = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($ArchName -ne 'AMD64') { throw "Only 64-bit Intel/AMD Windows (x64) is supported for now (found $ArchName)." }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Release signing key (ECDSA P-256, key id 6f357cf04af3cb4d); the private key stays offline on the maintainer's Mac.
$PubB64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6pZu7S24ONm8sScK1XgKDsklqr0Ft1So/uGHhPABBqbyLQjo5Tr7nJ0wI26IS+pbZowhgmkSJw/tHxifomD9yw=='

# Download with 3 tries and a 2 second pause; a half-written file is deleted first. The final message says what to do.
function Invoke-Download([string]$Uri, [string]$OutFile) {
  $Tries = 3
  for ($i = 1; $i -le $Tries; $i++) {
    try {
      Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
      return
    } catch {
      Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
      $Status = ''
      if ($_.Exception.Response) { $Status = " (HTTP $([int]$_.Exception.Response.StatusCode))" }
      if ($i -eq $Tries) {
        throw "Download failed after $Tries tries${Status}: $Uri`n$($_.Exception.Message)`nCheck your internet connection and run the same command again."
      }
      Start-Sleep -Seconds 2
    }
  }
}

function Get-ReleaseFile([string]$Name) {
  $destination = Join-Path $Temp $Name
  if ($Local) {
    $source = Join-Path $Local $Name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing release file: $source" }
    Copy-Item -LiteralPath $source -Destination $destination
  } else {
    Invoke-Download "$Base/$Name" $destination
  }
  return $destination
}

# DER ECDSA signature -> IEEE P1363 (r||s, 32 bytes each) for ECDsaCng
function ConvertTo-P1363([byte[]]$der) {
  if ($der[0] -ne 0x30) { throw 'bad signature encoding' }
  $i = 2; if ($der[1] -band 0x80) { $i = 2 + ($der[1] -band 0x7f) }
  $out = New-Object byte[] 64
  foreach ($part in 0, 1) {
    if ($der[$i] -ne 0x02) { throw 'bad signature encoding' }
    $len = $der[$i + 1]; $v = $der[($i + 2)..($i + 1 + $len)]; $i += 2 + $len
    while ($v.Length -gt 32 -and $v[0] -eq 0) { $v = $v[1..($v.Length - 1)] }
    [Array]::Copy($v, 0, $out, ($part * 32) + (32 - $v.Length), $v.Length)
  }
  return $out
}

function Assert-Signature([string]$File, [string]$SignatureFile) {
  $data = [IO.File]::ReadAllBytes($File); $sig = [IO.File]::ReadAllBytes($SignatureFile)
  $spki = [Convert]::FromBase64String($PubB64)
  $point = $spki[($spki.Length - 64)..($spki.Length - 1)]            # X||Y of the uncompressed P-256 point
  $blob = New-Object byte[] 72
  [BitConverter]::GetBytes([uint32]0x31534345).CopyTo($blob, 0)       # "ECS1": ECDSA P-256 public blob
  [BitConverter]::GetBytes([uint32]32).CopyTo($blob, 4)
  [Array]::Copy($point, 0, $blob, 8, 64)
  $key = [Security.Cryptography.CngKey]::Import($blob, [Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
  $ecdsa = New-Object Security.Cryptography.ECDsaCng($key)
  if (-not $ecdsa.VerifyData($data, (ConvertTo-P1363 $sig), [Security.Cryptography.HashAlgorithmName]::SHA256)) {
    throw "The signature of $(Split-Path -Leaf $File) does not verify; refusing to install."
  }
}

# Version key for the no-downgrade check: 1.19.3-ezk.2 -> 1,19,3,2
function ConvertTo-VersionKey([string]$v) {
  if ($v -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-ezk\.(\d+))?') { return $null }
  return @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $(if ($Matches[4]) { [int]$Matches[4] } else { 0 }))
}

# Windows PowerShell 5.1 redraws a progress bar for every chunk a download or an unzip handles, which turns fetching the ~60 MB archive
# into minutes. Silence it while we run and put the caller's value back (`irm ... | iex` runs in the caller's scope).
$PreviousProgress = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'

try {
  New-Item -ItemType Directory -Path $Temp -Force | Out-Null
  $Manifest = Get-ReleaseFile 'latest.json'
  $ManifestSignature = Get-ReleaseFile 'latest.json.sig'
  $Checksums = Get-ReleaseFile 'SHA256SUMS'
  $ChecksumsSignature = Get-ReleaseFile 'SHA256SUMS.sig'
  Assert-Signature $Manifest $ManifestSignature
  Assert-Signature $Checksums $ChecksumsSignature

  $Release = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
  $ResolvedVersion = [string]$Release.version
  if ($ResolvedVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'The signed manifest has an invalid version.' }
  if ($Version -and $Version -ne $ResolvedVersion) { throw "Requested version $Version is not the signed current release ($ResolvedVersion)." }

  # No downgrade: a replayed older (but genuinely signed) manifest must not replace a newer install.
  # A plain loop: piping the keys through ForEach-Object would unroll each 4-number array into loose numbers, and the comparison
  # below would then treat 19 (from 1.19.3) as a major version and refuse a genuine upgrade such as 1.19.3-ezk.2 -> 1.19.3-ezk.5.
  $InstalledNow = New-Object System.Collections.ArrayList
  foreach ($dir in @(Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'versions') -Directory -ErrorAction SilentlyContinue)) {
    $key = ConvertTo-VersionKey $dir.Name
    if ($key) { [void]$InstalledNow.Add($key) }
  }
  $NewKey = ConvertTo-VersionKey $ResolvedVersion
  if ($env:EZK_ALLOW_DOWNGRADE -ne '1' -and $NewKey) {
    foreach ($cur in $InstalledNow) {
      for ($i = 0; $i -lt 4; $i++) {
        if ($cur[$i] -ne $NewKey[$i]) {
          if ($cur[$i] -gt $NewKey[$i]) { throw "A newer version is already installed than the signed release $ResolvedVersion; refusing to downgrade (set EZK_ALLOW_DOWNGRADE=1 to force)." }
          break
        }
      }
    }
  }

  $ArchiveName = "ezkielyna-$ResolvedVersion-windows-x64.zip"
  $ChecksumLine = Select-String -LiteralPath $Checksums -Pattern ('^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($ArchiveName) + '$') | Select-Object -First 1
  if (-not $ChecksumLine) { throw "$ArchiveName is not listed in the signed SHA256SUMS." }
  $ExpectedHash = $ChecksumLine.Matches[0].Groups[1].Value.ToLowerInvariant()
  $Archive = Get-ReleaseFile $ArchiveName
  $ActualHash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualHash -ne $ExpectedHash) { throw "Checksum mismatch for $ArchiveName." }

  $Extracted = Join-Path $Temp 'extracted'
  Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted -Force
  $Executable = Get-ChildItem -LiteralPath $Extracted -Recurse -File | Where-Object { $_.Name -eq 'ezkielyna.exe' } | Select-Object -First 1
  if (-not $Executable) { throw 'The verified archive does not contain ezkielyna.exe.' }

  $VersionDir = Join-Path (Join-Path $InstallRoot 'versions') $ResolvedVersion
  New-Item -ItemType Directory -Path (Join-Path $InstallRoot 'versions') -Force | Out-Null
  if (Test-Path -LiteralPath $VersionDir) { Remove-Item -LiteralPath $VersionDir -Recurse -Force }
  New-Item -ItemType Directory -Path $VersionDir -Force | Out-Null
  $InstalledExe = Join-Path $VersionDir 'ezkielyna.exe'
  Copy-Item -LiteralPath $Executable.FullName -Destination $InstalledExe
  New-Item -ItemType Directory -Path $Bin -Force | Out-Null
  $Shim = "@echo off`r`n`"$InstalledExe`" %*`r`n"
  [IO.File]::WriteAllText((Join-Path $Bin 'ezkielyna.cmd'), $Shim, [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText((Join-Path $Bin 'ezk.cmd'), $Shim, [Text.Encoding]::ASCII)

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $PathEntries = @($UserPath -split ';' | Where-Object { $_ })
  if (-not $NoModifyPath -and (($PathEntries | ForEach-Object { $_.TrimEnd('\').ToLowerInvariant() }) -notcontains $Bin.TrimEnd('\').ToLowerInvariant())) {
    [Environment]::SetEnvironmentVariable('Path', ((@($PathEntries) + $Bin) -join ';'), 'User')
    Write-Output "Added $Bin to your user PATH. Open a new terminal to use the command."
  }
  Write-Output "Installed Ezkielyna Agent $ResolvedVersion to $InstalledExe (commands: ezkielyna, ezk)."
  Write-Output 'Run: ezkielyna     (first run asks for your Ezkielyna API key: https://api.ezkielyna.store/keys)'
} finally {
  $ProgressPreference = $PreviousProgress
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
