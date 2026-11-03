# Keep the native CLI exit status and surface diagnostics through the Checks API
# as well as runner logs (which can be inaccessible from restricted networks).
$ErrorActionPreference = 'Continue'
$tail = [System.Collections.Generic.Queue[string]]::new()
& npm run tauri -- build --no-bundle 2>&1 | ForEach-Object {
    $line = $_.ToString()
    Write-Host $line
    $tail.Enqueue($line)
    if ($tail.Count -gt 100) { $null = $tail.Dequeue() }
}
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    $details = $tail.ToArray() -join "`n"
    if ($details.Length -gt 4000) { $details = $details.Substring($details.Length - 4000) }
    $details = $details.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    Write-Host "::error title=Windows acceptance build failed::$details"
}
exit $exitCode
