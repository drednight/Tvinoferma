#requires -Version 5.1
<#
.SYNOPSIS
Build an unsigned local Windows acceptance executable. Never publishes or launches it.
#>
[CmdletBinding()]
param(
    [ValidateSet('Quick', 'Full', 'None')]
    [string]$Checks = 'Quick',
    [ValidateSet('Isolated', 'Shared')]
    [string]$Profile = 'Isolated',
    [string]$SharedProfileConfirmation = '',
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

function Test-DependenciesMatchLock {
    # Дешёвая строгая замена `npm ci`: сверяем установленное дерево с корневым
    # package-lock.json и требуем наличия CLI tauri. Отвечает «да» только если:
    #   1. каждый установленный пакет есть в lock с тем же version и integrity;
    #   2. каждый обязательный пакет из lock установлен;
    #   3. node_modules/.bin/tauri.cmd на месте (иначе сборка не стартует).
    # Необязательные пакеты (нативные сборки других ОС) не требуем.
    if (-not (Test-Path -LiteralPath 'node_modules/.bin/tauri.cmd' -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath 'node_modules/.package-lock.json' -PathType Leaf)) { return $false }
    $script = @'
const fs = require('fs');
const path = require('path');
const root = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages || {};
const tree = JSON.parse(fs.readFileSync('node_modules/.package-lock.json', 'utf8')).packages || {};
let problems = 0;
let checked = 0;
// 1. Установленное совпадает с lock по версии и (если известна обоим) по integrity.
for (const [name, meta] of Object.entries(tree)) {
  if (!name || meta.link) continue;
  const expected = root[name];
  // Пакеты, установленные как транзитивные уже после записи lock (npm пишет
  // node_modules/.package-lock.json сам), не считаем ошибкой: сверит npm ci.
  if (!expected) continue;
  checked += 1;
  if (expected.version !== meta.version) problems += 1;
  if (expected.integrity && meta.integrity && expected.integrity !== meta.integrity) problems += 1;
}
// 2. Каждый обязательный пакет из lock действительно установлен и на диске.
for (const [name, meta] of Object.entries(root)) {
  if (!name || meta.link || meta.optional || meta.dev) continue;
  if (!tree[name]) { problems += 1; continue; }
  if (!fs.existsSync(path.join(name, 'package.json'))) problems += 1;
}
// 3. dev-пакеты, от которых зависит сама сборка, тоже обязательны.
for (const name of ['node_modules/vite', 'node_modules/@tauri-apps/cli']) {
  if (!fs.existsSync(path.join(name, 'package.json'))) problems += 1;
}
// Страховка: пустой или вырожденный lock не должен считаться совпадением.
if (checked < 100) problems += 1;
process.stdout.write(problems === 0 ? 'yes' : 'no:' + problems);
'@
    $answer = & node -e $script
    if ($LASTEXITCODE -ne 0) { return $false }
    return ($answer -eq 'yes')
}

function Format-InstallFailure {
    # npm ci удаляет node_modules целиком. На Windows нативный .node-файл
    # (rolldown/vite, esbuild) может быть занят запущенным dev-сервером, редактором
    # или антивирусом — удаление падает с EPERM -4048. Подсказываем причину, а не
    # показываем сырой стек.
    param([string]$Output)
    if ($Output -match 'EPERM' -and $Output -match 'unlink') {
        $busy = @(
            'Закройте `npm run dev`, `npm run demo`, `vitest --watch` и окно VS Code/JetBrains с открытым проектом',
            'Остановите антивирус/индексатор на папке проекта или добавьте её в исключения',
            'Завершите оставшиеся node.exe: Get-Process node -ErrorAction SilentlyContinue | Stop-Process'
        )
        return "npm ci не смог удалить занятый файл в node_modules (EPERM). Повторите после того, как:`n - " + ($busy -join "`n - ") + "`nЕсли дерево зависимостей уже совпадает с lock-файлом, допустимо `-SkipInstall`."
    }
    return $null
}

function Read-Git {
    param([string[]]$Arguments)
    $lines = & git @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Git inspection failed.' }
    return ($lines -join "`n").Trim()
}

function Get-SourceSnapshot {
    $status = Read-Git -Arguments @('status', '--porcelain', '--untracked-files=normal')
    $trackedDiff = & git diff --binary HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Git source diff inspection failed.' }
    $untracked = & git ls-files --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'Git untracked file inspection failed.' }

    $source = New-Object System.Text.StringBuilder
    [void]$source.Append(($trackedDiff -join "`n"))
    foreach ($path in $untracked) {
        if (-not $path) { continue }
        $fullPath = Join-Path $root $path
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Untracked source is not a regular file: $path"
        }
        $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        [void]$source.Append("`nUNTRACKED:")
        [void]$source.Append($path)
        [void]$source.Append(':')
        [void]$source.Append($hash)
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($source.ToString())
        $fingerprint = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
    return [pscustomobject]@{ Status = $status; Fingerprint = $fingerprint }
}

Push-Location $root
try {
    if (
        $Profile -eq 'Shared' -and
        $SharedProfileConfirmation -cne 'I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA'
    ) {
        throw 'Shared profile reads and modifies production data and vault. Back up first and pass -SharedProfileConfirmation I_HAVE_BACKUP_AND_ACCEPT_SHARED_DATA explicitly.'
    }
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
    $sourceSnapshot = Get-SourceSnapshot
    $dirty = [bool]$sourceSnapshot.Status
    if ($dirty -and -not $AllowDirty) {
        throw 'Working tree has changes. Commit/review them first, or explicitly use -AllowDirty (the exact source fingerprint will be recorded). No files were reset.'
    }
    Write-Host "Source: $source ($branch); dirty=$dirty"
    if ($dirty) {
        Write-Warning "Building reviewed local changes; source fingerprint: $($sourceSnapshot.Fingerprint)"
    }
    if ($Profile -eq 'Shared') {
        Write-Warning 'SHARED PROFILE: this test executable reads and modifies production data, vault and cloud settings. Close stable and back up first.'
    } else {
        Write-Host 'Unsigned acceptance profile. Local profile/vault separation is NOT yet verified on Windows.'
        Write-Host 'Use a separate Windows test user, test accounts and test GameCenter installation.'
    }
    Write-Host 'No release, installer, updater signature, git checkout/pull or automatic application launch.'
    Write-Host 'Cloud OAuth integrations need your own documented build environment; no GitHub secrets are downloaded.'

    $dependencyFiles = @('package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock')
    $dependencyHashes = @{}
    foreach ($file in $dependencyFiles) {
        $dependencyHashes[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
    $env:CARGO_TARGET_DIR = Join-Path $root 'src-tauri\target\acceptance'
    $config = 'src-tauri/tauri.acceptance.conf.json'
    $feature = 'acceptance'
    $exeName = 'Tvinoferma.exe'
    if ($Profile -eq 'Shared') {
        $env:CARGO_TARGET_DIR = Join-Path $root 'src-tauri\target\acceptance-shared'
        $config = 'src-tauri/tauri.acceptance-shared.conf.json'
        $feature = 'acceptance-shared'
        $exeName = 'Tvinoferma-SHARED-TEST.exe'
    }
    $env:CARGO_BUILD_TARGET = $target
    $env:CARGO_PROFILE_RELEASE_LTO = 'false'
    $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
    $env:SKIP_GIT_HOOKS = '1'

    if (-not $SkipInstall) {
        # Если дерево зависимостей уже точно совпадает с lock-файлом, `npm ci` только
        # переустановит те же пакеты — и на Windows может упасть с EPERM на занятом
        # нативном модуле. Проверка дешёвая и строгая, поэтому переустановку пропускаем.
        if (Test-DependenciesMatchLock) {
            Write-Host 'Dependencies already match package-lock.json; npm ci skipped.'
        } else {
            # Вывод идёт через cmd-перенаправление в файл: в PowerShell 5.1 `2>&1`
            # у нативной команды превращает stderr в ErrorRecord, а при
            # $ErrorActionPreference = 'Stop' — в исключение вместо кода возврата.
            $installLog = Join-Path ([System.IO.Path]::GetTempPath()) "tvinoferma-npm-ci-$([guid]::NewGuid().ToString('N')).log"
            try {
                & cmd.exe /d /c ('npm.cmd ci --no-audit --no-fund > "' + $installLog + '" 2>&1')
                $installCode = $LASTEXITCODE
                $installOutput = if (Test-Path -LiteralPath $installLog) { Get-Content -LiteralPath $installLog -Raw } else { '' }
                if ($installOutput) { Write-Host $installOutput.TrimEnd() }
                if ($installCode -ne 0) {
                    $explained = Format-InstallFailure -Output ([string]$installOutput)
                    if ($explained) { throw $explained }
                    throw "npm.cmd failed (exit $installCode). See the diagnostic output above."
                }
            } finally {
                Remove-Item -LiteralPath $installLog -ErrorAction SilentlyContinue
            }
        }
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
    Invoke-Checked -Program 'npm.cmd' -Arguments @('run', 'tauri', '--', 'build', '--no-bundle', '--no-sign', '--target', $target, '--config', $config, '--features', $feature, '--', '--locked')
    if ($Checks -eq 'Full') {
        Push-Location (Join-Path $root 'src-tauri')
        try {
            Invoke-Checked -Program 'cargo' -Arguments @('test', '--locked', '--target', $target, '--features', $feature, '--lib')
        } finally { Pop-Location }
    }
    foreach ($file in $dependencyFiles) {
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $dependencyHashes[$file]) {
            throw "Dependency file changed during build: $file. Output was not packaged; review the file, do not silently reset it."
        }
    }
    if ((Read-Git -Arguments @('rev-parse', 'HEAD')) -ne $source) { throw 'HEAD changed during build; output was not packaged.' }
    $finalSourceSnapshot = Get-SourceSnapshot
    if (
        $finalSourceSnapshot.Status -ne $sourceSnapshot.Status -or
        $finalSourceSnapshot.Fingerprint -ne $sourceSnapshot.Fingerprint
    ) {
        throw 'Source tree changed during build; output was not packaged.'
    }
    $executable = Join-Path $env:CARGO_TARGET_DIR "$target\release\tvinoferma.exe"
    if (-not (Test-Path -LiteralPath $executable)) { throw "Build reported success but executable is missing: $executable" }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $output = Join-Path $root "local-acceptance\$($Profile.ToLowerInvariant())-$stamp-$($source.Substring(0, 8))-$suffix"
    $null = New-Item -ItemType Directory -Path $output
    Copy-Item -LiteralPath $executable -Destination (Join-Path $output $exeName)
    $hash = (Get-FileHash -LiteralPath (Join-Path $output $exeName) -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $exeName" | Set-Content -Encoding ascii -LiteralPath (Join-Path $output 'SHA256SUMS.txt')
    $version = (Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
    $manifest = [ordered]@{
        source = $source; branch = $branch; dirty = $dirty; sourceFingerprint = $sourceSnapshot.Fingerprint; version = $version
        builtAt = [DateTime]::UtcNow.ToString('o'); target = $target; checks = $Checks
        dependencyInstallSkipped = [bool]$SkipInstall; sha256 = $hash
        lto = $false; codegenUnits = 16; signed = $false; profile = $feature; sharedProductionProfile = ($Profile -eq 'Shared'); isolatedProfile = ($Profile -eq 'Isolated'); isolationVerified = $false
    }
    $manifest | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath (Join-Path $output 'BUILD-INFO.json')
    $profileWarning = if ($Profile -eq 'Shared') {
        @"
SHARED PRODUCTION PROFILE: the test build reads and WRITES the same data,
Windows vault, browser profiles and cloud settings as the stable app.
Close the stable version completely and back up data and vault before running.
Changes, reset and synchronisation can affect production and other devices.
Shared profile behavior and WebView sessions need verification on Windows.
"@
    } else {
        @"
Use a SEPARATE Windows test user with no production Tvinoferma data.
A separate app identifier and OS vault namespace are configured, but NOT verified on Windows.
Do NOT run alongside another version or against your working profile.
"@
    }
    @"
UNSIGNED TEST BUILD - NOT A STABLE UPDATE
Source: $source
Branch: $branch
Working tree dirty: $dirty (if true, see the non-secret sourceFingerprint in BUILD-INFO.json)
Source fingerprint: $($sourceSnapshot.Fingerprint)
Embedded version: $version (does NOT distinguish this build from stable)
Profile: $feature
Checks: $Checks; dependency install skipped: $SkipInstall

Requires Microsoft Edge WebView2 Runtime.
$profileWarning
GameCenter files, live game windows and cloud accounts are external shared resources.
Updates are disabled. No installer, updater signature or release was produced.
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
