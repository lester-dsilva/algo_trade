# Backfill all missing 2024 data (month by month). Run from repo root:
#   powershell -ExecutionPolicy Bypass -File scripts/fetchYear2024.ps1
# Progress also in: data/fetch_2024_log.txt ([START]/[OK] lines from fetchMonth).
$ROOT = "C:\Users\user\OneDrive\Desktop\stocks"
$LOG = Join-Path $ROOT "data\fetch_2024_log.txt"
Set-Location $ROOT
New-Item -ItemType Directory -Force -Path (Split-Path $LOG) | Out-Null
function Log($m) { $m | Tee-Object -FilePath $LOG -Append }
Log "=== fetchYear2024 started $(Get-Date -Format o) ==="
1..12 | ForEach-Object {
  $month = "2024-{0:D2}" -f $_
  Log "`n========== $month =========="
  & node v2/scripts/fetchMonth.js $month --concurrency 2 2>&1 | ForEach-Object { Log $_ }
  Log "--- month exit code: $LASTEXITCODE ---"
}
Log "=== fetchYear2024 finished $(Get-Date -Format o) ==="
