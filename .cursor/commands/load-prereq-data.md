# Load prereq data

Load and verify the backtest **prerequisite** data (Smallcap-100 market-regime index files) up to a given date, then report which per-stock day folders are still missing.

## Input

A target date `YYYY-MM-DD` — the last date prereq data should cover (usually today).

**If the user did not give a date, ASK for it before doing anything else.** Do not assume today's date.

## What to do

1. Confirm the Kite session is fresh: read `.kite_session` and check `login_time` is the same day as the target date. If it is stale or missing, tell the user to run `npm run kite:login` (they must do the interactive login themselves — suggest they type `! npm run kite:login`).

2. Run the loader with the target date:

   ```
   node v2/scripts/loadPrereqData.js <YYYY-MM-DD>
   ```

   This rebuilds `v2/data/smallcap100_daily.json` and `v2/data/smallcap100_3m.json` (token 267017) from `2023-10-01` through the target date, verifies the regime + daily-trend maps resolve through the last trading day, and audits the per-stock day folders.

3. Report back to the user:
   - the last date the regime data now covers, and the latest `dist50` / `slope20` (whether the index is above/below its 50MA — i.e. whether the size-down gate is active);
   - the list of **missing per-stock day folders** the script prints. These are NOT loaded by this command — the user loads per-stock OHLC/3m data themselves via the dashboard month/date loaders (`npm run dev:all:watch`). Just surface the gap.

## Notes

- Prereq = index regime files only. They are rebuilt in full each run (no gap-filling), so re-running for a later date is always safe.
- The script never fetches per-stock data; it only audits it.
- If the fetch fails at auth (401), the token expired — re-login and re-run.
