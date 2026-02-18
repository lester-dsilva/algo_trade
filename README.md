# Stocks — Data analysis scripts

Simple Node.js scripts for intraday data analysis (flag/triangle breakout, pullback to 20 EMA, momentum). No Electron yet; run from the command line.

## Data format

CSV with columns: `date`, `time`, `open`, `high`, `low`, `close`, `volume`. See `DATA_FORMAT.md`. Put files in `data/` or pass a path.

## Scripts

| Script         | Purpose |
|----------------|---------|
| `loadCsv.js`   | Read OHLCV CSV → JSON candles |
| `ema.js`       | Add 20-period EMA (close) to candles |
| `momentum.js`  | Add `pctFromOpen`, `rangePct` |
| `analyze.js`   | Find bars where price is near or undercuts 20 EMA (pullback zone) |
| `findEntries.js` | Find all entry types: triangle breakout, pullback to EMA, **reversal breakout** (gap down then first close above 20 EMA). Primary TF 3m; optional `--ltf=` for 1m refinement. |

## Run (no install needed; Node 18+)

**Load one file:**
```bash
node scripts/loadCsv.js data/sample.csv
```

**Full pipeline (load → EMA → find pullbacks):**
```bash
node scripts/loadCsv.js data/sample.csv | node scripts/ema.js | node scripts/analyze.js
```

**With tolerance (price within 0.3% of EMA):**
```bash
node scripts/loadCsv.js data/sample.csv | node scripts/ema.js | node scripts/analyze.js -- --tolerance=0.3
```

**Add momentum then analyze:**
```bash
node scripts/loadCsv.js data/sample.csv | node scripts/ema.js | node scripts/momentum.js | node scripts/analyze.js
```

(On Windows PowerShell you may need to pass stdin differently, e.g. `Get-Content enriched.json | node scripts/analyze.js`.)

**Find entries (3m CSV; triangle breakout, pullback to EMA, reversal breakout):**
```bash
node scripts/findEntries.js data/prajind.csv --tolerance=2
```

**With 1m refinement (primary TF 3m; optional lower TF for exact bar):**
```bash
node scripts/kiteOHLC.js NSE:PRAJIND 3minute 2026-02-10 2026-02-18 data/prajind.csv
node scripts/kiteOHLC.js NSE:PRAJIND minute 2026-02-10 2026-02-18 data/prajind_1m.csv
node scripts/findEntries.js data/prajind.csv --ltf=data/prajind_1m.csv
```

Reversal breakout = gap down then first close above 20 EMA (with volume). Use `--ltf=<path>` to refine the exact 1m bar within the 3m signal window.

## Sample data

`data/sample.csv` is one day of 3-minute-style candles (Bharat Seats–style move: open surge then grind up). Use your own CSV for real analysis.

## Zerodha Kite Connect

Credentials from `.env`. Supported variable names:

- `KITE_API_KEY` or `api_key` or `API_KEY`
- `KITE_API_SECRET` or `api_secret` or `API_SECRET`
- `KITE_REQUEST_TOKEN` or `request_token` or `REQUEST_TOKEN`

Copy `.env.example` to `.env` and fill in. Get API key from [Kite apps](https://kite.zerodha.com/apps); request token comes from the redirect URL after you log in via the Kite login URL.

**Install deps (for Kite):**
```bash
npm install
```

**Verify session:**
```bash
npm run kite:session
```

**Fetch OHLC for a date range (instrument, interval, from, to):**
```bash
node scripts/kiteOHLC.js NSE:RELIANCE 3minute 2026-02-16 2026-02-18
node scripts/kiteOHLC.js NSE:BHARATSE day 2026-01-01 2026-02-17
```
Intervals: `minute`, `3minute`, `5minute`, `15minute`, `30minute`, `60minute`, `day`. Output is CSV to stdout.

**Single-day intraday (legacy):**
```bash
node scripts/kiteHistorical.js NSE:RELIANCE 2026-02-16
node scripts/kiteHistorical.js NSE:BHARATSE 2026-02-16 3minute
```

Redirect to a file and run the analysis pipeline:
```bash
node scripts/kiteOHLC.js NSE:BHARATSE 3minute 2026-02-16 2026-02-18 > data/bharatse.csv
node scripts/loadCsv.js data/bharatse.csv | node scripts/ema.js | node scripts/analyze.js
```

`lib/kite.js` exports `getKite()` (authenticated client) and `generateSession()` for use in other scripts.

## Next steps

- Add more indicators (e.g. flag/consolidation detection, breakout detection).
- Backtest: apply entry/exit rules and measure 1:2 RR and trailing.
- Later: Electron app that uses these scripts or their logic.
