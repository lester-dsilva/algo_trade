# Kill sequential 2024/2025 data fetch (node fetchBacktestData + parent PowerShell)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object {
  if ($_.CommandLine -match 'fetchBacktestData') {
    Write-Host "Killing node PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | ForEach-Object {
  if ($_.CommandLine -match 'fetchMissingMonths') {
    Write-Host "Killing powershell PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Write-Host "Done."
