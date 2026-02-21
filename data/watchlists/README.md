# Watchlists by date

One folder per date: `YYYY-MM-DD/`. Each folder can contain:

- **watchlist.txt** – symbols (one per line) used for that day’s run. Committed so we can compare runs and avoid algo regression.
- **entries_pnl.txt** – optional copy of entry + P&L output for that date (baseline when refining exit logic).

Example:

- `2026-02-18/watchlist.txt` + `2026-02-18/entries_pnl.txt`
- `2026-02-19/watchlist.txt` + `2026-02-19/entries_pnl.txt`

Run PnL for a date using this watchlist:

```bash
node scripts/analyzePnl.js YYYY-MM-DD --watchlist data/watchlists/YYYY-MM-DD/watchlist.txt
```
