# v2 — Backtest data & algo

Data is organised **by date** under `v2/data/YYYY-MM-DD/`.

## Data layout (per backtest date)

For backtest date **D** you get:

| Path | Description |
|------|-------------|
| `v2/data/YYYY-MM-DD/prev_day_ohlc.csv` | Previous trading day OHLC for full universe. Columns: `symbol,date,open,high,low,close,volume` |
| `v2/data/YYYY-MM-DD/3m/<symbol>.csv` | 3-minute bars for that day. Columns: `date,time,open,high,low,close,volume` |

Full universe = **`config/nse_mcap_above_900cr.csv`** (same as live scanner). Regenerate with `node scripts/buildWatchlistFromMcap.js` if needed.

## Fetching data

Run from **repo root** (so `lib/kite.js` and `config/` are available):

```bash
node v2/scripts/fetchBacktestData.js YYYY-MM-DD
node v2/scripts/fetchBacktestData.js 2026-03-05 --force   # re-fetch existing
```

- Fetches **previous day OHLC** (daily bar for the day before the backtest date) for all symbols.
- Fetches **3m OHLC** for the backtest date for all symbols.
- Skips symbols that already have files unless `--force` is used.

`v2/data/` is in `.gitignore` — data is local only.
