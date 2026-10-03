$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $root 'local-private\review-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('review-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$node = (Get-Command node.exe -ErrorAction Stop).Source
Push-Location $root
try {
    & $node (Join-Path $PSScriptRoot 'review.mjs') --live *> $log
    if ($LASTEXITCODE -ne 0) { throw 'Candidate review incomplete; inspect local-private logs.' }
} finally { Pop-Location }
