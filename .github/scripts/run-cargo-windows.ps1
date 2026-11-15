# Run the normal Windows CI checks without hiding cargo's exit status.
# The last diagnostic lines are also GitHub annotations so a failure can be
# inspected via the Checks API when runner log downloads are unavailable.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('test', 'fmt', 'clippy', 'credential-smoke')]
    [string] $Check
)

$ErrorActionPreference = 'Continue'
$env:CARGO_TERM_COLOR = 'never'
$arguments = switch ($Check) {
    'test' { @('test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml') }
    'credential-smoke' {
        if ($env:TF_RUN_CREDENTIAL_MANAGER_TESTS -ne '1') {
            throw 'Credential Manager smoke requires TF_RUN_CREDENTIAL_MANAGER_TESTS=1'
        }
        @('test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib',
          'credential_manager_binding_and_one_time_claim_with_synthetic_values', '--', '--nocapture')
    }
    'fmt' { @('fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--check') }
    'clippy' { @('clippy', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings') }
}
$script:smokePassed = $false
function Invoke-MeasuredCargo {
param([string] $Stage, [string[]] $CargoArguments)
$clock = [Diagnostics.Stopwatch]::StartNew()
$tail = [System.Collections.Generic.Queue[string]]::new()
& cargo @CargoArguments 2>&1 | ForEach-Object {
    $line = $_.ToString()
    Write-Host $line
    if ($line -match '^test .*::credential_manager_binding_and_one_time_claim_with_synthetic_values \.\.\. ok$') {
        $script:smokePassed = $true
    }
    $tail.Enqueue($line)
    if ($tail.Count -gt 160) { $null = $tail.Dequeue() }
}
$exitCode = $LASTEXITCODE
$clock.Stop()
$seconds = [math]::Round($clock.Elapsed.TotalSeconds, 2)
Write-Host "::notice title=Rust stage timing::$Stage took $seconds seconds; exit=$exitCode"
if ($env:GITHUB_STEP_SUMMARY) {
    "| $Stage | $seconds s | $exitCode |" >> $env:GITHUB_STEP_SUMMARY
}
if ($exitCode -ne 0) {
    $details = $tail.ToArray() -join "`n"
    # GitHub truncates long annotation messages; keep the END (actual errors).
    if ($details.Length -gt 3000) { $details = $details.Substring($details.Length - 3000) }
    $details = $details.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    Write-Host "::error title=Windows cargo $Stage failed::$details"
    exit $exitCode
}
}
if ($env:GITHUB_STEP_SUMMARY) {
    "### Cargo $Check stages" >> $env:GITHUB_STEP_SUMMARY
    "| Stage | Wall time | Exit |" >> $env:GITHUB_STEP_SUMMARY
    "| --- | --- | --- |" >> $env:GITHUB_STEP_SUMMARY
}
if ($Check -eq 'test') {
    Invoke-MeasuredCargo -Stage 'compile-and-link-tests' -CargoArguments ($arguments + @('--no-run', '--timings'))
    Invoke-MeasuredCargo -Stage 'execute-tests-with-cargo-freshness-check' -CargoArguments $arguments
} else {
    Invoke-MeasuredCargo -Stage $Check -CargoArguments $arguments
}
if ($Check -eq 'credential-smoke') {
    if (-not $smokePassed) {
        Write-Host '::error title=Credential Manager smoke missing::The opt-in test did not report a passing result.'
        exit 1
    }
    Write-Host '::notice title=Credential Manager smoke passed::The opt-in Windows test ran with synthetic Google and Yandex records.'
}
