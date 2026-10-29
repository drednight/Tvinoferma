# Run the normal Windows CI checks without hiding cargo's exit status.
# The last diagnostic lines are also GitHub annotations so a failure can be
# inspected via the Checks API when runner log downloads are unavailable.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('test', 'fmt', 'clippy')]
    [string] $Check
)

$ErrorActionPreference = 'Continue'
$env:CARGO_TERM_COLOR = 'never'
$arguments = switch ($Check) {
    'test' { @('test', '--manifest-path', 'src-tauri/Cargo.toml') }
    'fmt' { @('fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--check') }
    'clippy' { @('clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings') }
}
$tail = [System.Collections.Generic.Queue[string]]::new()
& cargo @arguments 2>&1 | ForEach-Object {
    $line = $_.ToString()
    Write-Host $line
    $tail.Enqueue($line)
    if ($tail.Count -gt 160) { $null = $tail.Dequeue() }
}
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    $details = $tail.ToArray() -join "`n"
    # GitHub truncates long annotation messages; keep the END (actual errors).
    if ($details.Length -gt 3000) { $details = $details.Substring($details.Length - 3000) }
    $details = $details.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    Write-Host "::error title=Windows cargo $Check failed::$details"
    exit $exitCode
}
