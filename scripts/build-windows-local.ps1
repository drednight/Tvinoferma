#requires -Version 5.1
<#
.SYNOPSIS
Build an unsigned local Windows acceptance executable. Never publishes or launches it.
#>
[CmdletBinding()]
param(
    [ValidateSet('Quick', 'Full', 'None')]
    [string]$Checks = 'Quick',
    [switch]$SkipInstall,
    [switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# PowerShell 7 can otherwise turn native nonzero exits into exceptions before our check.
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path -Parent $PSScriptRoot
$target = 'x86_64-pc-windows-msvc'
$environmentNames = @('CARGO_TARGET_DIR', 'CARGO_BUILD_TARGET', 'CARGO_PROFILE_RELEASE_LTO', 'CARGO_PROFILE_RELEASE_CODEGEN_UNITS', 'SKIP_GIT_HOOKS')
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program failed (exit $LASTEXITCODE). See the diagnostic output above."
    }
}

function Read-Git {
    param([string[]]$Arguments)
    $lines = & git @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Git inspection failed.' }
    return ($lines -join "`n").Trim()
}

Push-Location $root
try {
    if ($env:OS -ne 'Windows_NT') { throw 'This script must run on Windows x64 with the MSVC Rust toolchain.' }
    foreach ($program in @('git', 'node', 'npm.cmd', 'cargo', 'rustc')) {
        if (-not (Get-Command $program -ErrorAction SilentlyContinue)) {
            throw "Missing prerequisite: $program. See docs/LOCAL-WINDOWS-BUILD.md."
        }
    }
    $nodeVersion = & node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.12.0') {
        throw 'Node.js 22.12 or newer is required. Node 22 LTS is recommended.'
    }
    $rustInfo = & rustc -vV
    if ($LASTEXITCODE -ne 0 -or -not ($rustInfo -match '^host: x86_64-pc-windows-msvc$')) {
        throw 'Use the x86_64-pc-windows-msvc Rust toolchain (rustup default stable-x86_64-pc-windows-msvc).'
    }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        throw 'Install Visual Studio Build Tools: Desktop development with C++, MSVC x64/x86 and Windows 10/11 SDK.'
    }
    $visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $visualStudio) {
        throw 'MSVC C++ build tools were not found. Install Desktop development with C++ and a Windows SDK.'
    }

    $source = Read-Git -Arguments @('rev-parse', 'HEAD')
    $branch = Read-Git -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
    $status = Read-Git -Arguments @('status', '--porcelain', '--untracked-files=normal')
    $dirty = [bool]$status
    if ($dirty -and -not $AllowDirty) {
        throw 'Working tree has changes. Commit/review them first, or explicitly use -AllowDirty (source identity will be marked DIRTY). No files were reset.'
    }
    Write-Host "Source: $source ($branch); dirty=$dirty"
    Write-Host 'Unsigned acceptance profile. Local profile/vault separation is NOT yet verified on Windows.'
    Write-Host 'Use a separate Windows test user, test accounts and test GameCenter installation.'
    Write-Host 'No release, installer, updater signature, git checkout/pull or automatic application launch.'
    Write-Host 'Cloud OAuth integrations need your own documented build environment; no GitHub secrets are downloaded.'

    $dependencyFiles = @('package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock')
    $dependencyHashes = @{}
    foreach ($file in $dependencyFiles) {
        $dependencyHashes[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
    $env:CARGO_TARGET_DIR = Join-Path $root 'src-tauri\target\acceptance'
    $env:CARGO_BUILD_TARGET = $target
    $env:CARGO_PROFILE_RELEASE_LTO = 'false'
    $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
    $env:SKIP_GIT_HOOKS = '1'

    if (-not $SkipInstall) {
        Invoke-Checked -Program 'npm.cmd' -Arguments @('ci', '--no-audit', '--no-fund')
    } elseif (-not (Test-Path 'node_modules/.bin/tauri.cmd')) {
        throw '-SkipInstall requires existing dependencies. Run again without -SkipInstall.'
    } else {
        Write-Warning 'Dependency installation skipped. Exact correspondence to package-lock.json is not verified.'
    }
    if ($Checks -ne 'None') {
        foreach ($check in @('lint', 'format:check', 'typecheck')) {
            Invoke-Checked -Program 'npm.cmd' -Arguments @('run', $check)
        }
    }
    if ($Checks -eq 'Full') {
        Invoke-Checked -Program 'npm.cmd' -Arguments @('test')
    }

    # Tauri runs beforeBuildCommand (vite build). Extra runner args enforce Cargo.lock.
    Invoke-Checked -Program 'npm.cmd' -Arguments @('run', 'tauri', '--', 'build', '--no-bundle', '--no-sign', '--target', $target, '--config', 'src-tauri/tauri.acceptance.conf.json', '--features', 'acceptance', '--', '--locked')
    if ($Checks -eq 'Full') {
        Push-Location (Join-Path $root 'src-tauri')
        try {
            Invoke-Checked -Program 'cargo' -Arguments @('test', '--locked', '--target', $target, '--features', 'acceptance', '--lib')
        } finally { Pop-Location }
    }
    foreach ($file in $dependencyFiles) {
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $dependencyHashes[$file]) {
            throw "Dependency file changed during build: $file. Output was not packaged; review the file, do not silently reset it."
        }
    }
    if ((Read-Git -Arguments @('rev-parse', 'HEAD')) -ne $source) { throw 'HEAD changed during build; output was not packaged.' }
    if (-not $AllowDirty -and (Read-Git -Arguments @('status', '--porcelain', '--untracked-files=normal'))) {
        throw 'Source tree changed during build; output was not packaged.'
    }
    $executable = Join-Path $env:CARGO_TARGET_DIR "$target\release\tvinoferma.exe"
    if (-not (Test-Path -LiteralPath $executable)) { throw "Build reported success but executable is missing: $executable" }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $output = Join-Path $root "local-acceptance\$stamp-$($source.Substring(0, 8))-$suffix"
    $null = New-Item -ItemType Directory -Path $output
    Copy-Item -LiteralPath $executable -Destination (Join-Path $output 'Tvinoferma.exe')
    $hash = (Get-FileHash -LiteralPath (Join-Path $output 'Tvinoferma.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  Tvinoferma.exe" | Set-Content -Encoding ascii -LiteralPath (Join-Path $output 'SHA256SUMS.txt')
    $version = (Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
    $manifest = [ordered]@{
        source = $source; branch = $branch; dirty = $dirty; version = $version
        builtAt = [DateTime]::UtcNow.ToString('o'); target = $target; checks = $Checks
        dependencyInstallSkipped = [bool]$SkipInstall; sha256 = $hash
        lto = $false; codegenUnits = 16; signed = $false; profile = 'acceptance'; isolatedProfile = $false; isolationVerified = $false
    }
    $manifest | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath (Join-Path $output 'BUILD-INFO.json')
    @"
UNSIGNED TEST BUILD - NOT A STABLE UPDATE
Source: $source
Branch: $branch
Working tree dirty: $dirty (if true, commit alone does not identify the source)
Embedded version: $version (does NOT distinguish this build from stable)
Checks: $Checks; dependency install skipped: $SkipInstall

Requires Microsoft Edge WebView2 Runtime.
Use a SEPARATE Windows test user with no production Tvinoferma data.
A separate app identifier and OS vault namespace are configured, but NOT verified on Windows.
Do NOT run alongside another version or against your working profile.
GameCenter files, live game windows and cloud accounts are external shared resources;
use only disposable test installations, accounts and windows. Updates are disabled.
No installer, updater signature or release was produced. LTO is disabled.
Quick/None are NOT a full CI pass. A successful build is NOT a game-input test.
OAuth/cloud features may be unavailable without the appropriate build variables.
Keep passwords, tokens, cookies, backups and private environment values out of reports.
The script did not start the executable. Test it manually only after reading this file.
"@ | Set-Content -Encoding utf8 -LiteralPath (Join-Path $output 'READ-ME.txt')
    Write-Host "SUCCESS: $output"
    Write-Host "SHA256: $hash"
    Write-Host 'Read READ-ME.txt before manually starting the executable.'
} finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    Pop-Location
}
