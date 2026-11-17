#requires -Version 5.1
<#
.SYNOPSIS
Launch the newest verified local Windows acceptance executable.
#>
[CmdletBinding()]
param(
    [ValidateSet('Isolated', 'Shared')]
    [string]$Profile = 'Isolated',
    [string]$SharedProfileConfirmation = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sharedConfirmation = 'I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA'

if ($Profile -eq 'Shared' -and $SharedProfileConfirmation -cne $sharedConfirmation) {
    throw 'Shared profile reads and modifies production data and vault. Back up first and pass -SharedProfileConfirmation I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA explicitly.'
}

$artifactRoot = Join-Path $root 'local-acceptance'
if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) {
    throw 'No local Windows build exists. Run the matching build task first.'
}
$prefix = if ($Profile -eq 'Shared') { 'shared-*' } else { 'isolated-*' }
$latest = Get-ChildItem -LiteralPath $artifactRoot -Directory -Filter $prefix |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $latest) { throw "No $Profile local Windows build exists. Run the matching build task first." }

$manifestPath = Join-Path $latest.FullName 'BUILD-INFO.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'The newest build has no BUILD-INFO.json; rebuild instead of launching it.'
}
try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} catch {
    throw 'The newest build manifest is unreadable; rebuild instead of launching it.'
}
$expectedProfile = if ($Profile -eq 'Shared') { 'acceptance-shared' } else { 'acceptance' }
$expectedExecutable = if ($Profile -eq 'Shared') { 'Tvinoferma-SHARED-TEST.exe' } else { 'Tvinoferma.exe' }
$expectedShared = $Profile -eq 'Shared'
$expectedIsolated = $Profile -eq 'Isolated'
if (
    $manifest.profile -ne $expectedProfile -or
    [bool]$manifest.sharedProductionProfile -ne $expectedShared -or
    [bool]$manifest.isolatedProfile -ne $expectedIsolated -or
    [bool]$manifest.signed -or
    [string]$manifest.target -ne 'x86_64-pc-windows-msvc'
) {
    throw 'The newest build metadata does not match the selected profile; rebuild instead of launching it.'
}

$executable = Join-Path $latest.FullName $expectedExecutable
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'The executable is missing from the newest build; rebuild instead of launching it.'
}
$actualHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ([string]$manifest.sha256 -cne $actualHash) {
    throw 'The executable hash does not match BUILD-INFO.json; rebuild instead of launching it.'
}

$existingApp = Get-Process -Name 'Tvinoferma', 'Tvinoferma-SHARED-TEST' -ErrorAction SilentlyContinue
if ($existingApp) {
    throw 'A Tvinoferma process is already running. Close the main app and its tray process completely before starting a local test build.'
}
if ($Profile -eq 'Shared') {
    Write-Warning 'SHARED PROFILE: this test version can change the current app data, vault and cloud settings. Verify independent backups before continuing.'
} else {
    Write-Warning 'Isolated profile separation is not yet verified on Windows. Use a separate Windows test account and synthetic data.'
}
$process = Start-Process -FilePath $executable -WorkingDirectory $latest.FullName -PassThru
Write-Host "Started $expectedExecutable from $($latest.FullName) (PID $($process.Id))."
