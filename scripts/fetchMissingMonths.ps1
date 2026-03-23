# Fetches all of 2024 day by day (sequentially) to avoid rate limits.
# Run from repo root: powershell -File scripts/fetchMissingMonths.ps1

$ROOT = "C:\Users\user\OneDrive\Desktop\stocks"
$FETCH_SCRIPT = "$ROOT\v2\scripts\fetchBacktestData.js"
$DATA_DIR = "$ROOT\v2\data"

# NSE holidays 2024
$HOLIDAYS = @(
    "2024-01-22",  # Ram Mandir consecration (special)
    "2024-01-26",  # Republic Day
    "2024-03-25",  # Holi
    "2024-04-09",  # Gudi Padwa / Ram Navami
    "2024-04-14",  # Ambedkar Jayanti / Dr. Baba Saheb Ambedkar Jayanti
    "2024-04-17",  # Ram Navami
    "2024-04-21",  # Mahavir Jayanti
    "2024-05-23",  # Buddha Purnima
    "2024-06-17",  # Bakri Eid
    "2024-07-17",  # Muharram
    "2024-08-15",  # Independence Day
    "2024-10-02",  # Mahatma Gandhi Jayanti
    "2024-11-01",  # Diwali Laxmi Puja
    "2024-11-15",  # Gurunanak Jayanti
    "2024-12-25"   # Christmas
)

$dates = @()
$start = [datetime]"2024-01-01"
$end   = [datetime]"2024-12-31"
$cur   = $start
while ($cur -le $end) {
    $dow = $cur.DayOfWeek
    $ds  = $cur.ToString("yyyy-MM-dd")
    if ($dow -ne "Saturday" -and $dow -ne "Sunday" -and $HOLIDAYS -notcontains $ds) {
        $dates += $ds
    }
    $cur = $cur.AddDays(1)
}

Write-Host "Dates to fetch: $($dates.Count)"

foreach ($date in $dates) {
    $outDir = "$DATA_DIR\$date"
    $prevFile = "$outDir\prev_day_ohlc.csv"
    $threeMDir = "$outDir\3m"

    # Skip if already has data
    if ((Test-Path $prevFile) -and (Test-Path $threeMDir)) {
        $csvCount = (Get-ChildItem $threeMDir -Filter "*.csv" -ErrorAction SilentlyContinue).Count
        if ($csvCount -gt 0) {
            Write-Host "[SKIP] $date (already have $csvCount symbols)"
            continue
        }
    }

    Write-Host ""
    Write-Host "=== Fetching $date ==="
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    & node $FETCH_SCRIPT $date
    $exitCode = $LASTEXITCODE

    $sw.Stop()
    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 1)

    if ($exitCode -eq 0) {
        Write-Host "[OK] $date done in ${elapsed}s"
    } else {
        Write-Host "[FAIL] $date exited $exitCode after ${elapsed}s"
    }

    # Small pause between dates to be gentle on the API
    Start-Sleep -Seconds 3
}

Write-Host ""
Write-Host "All done."
