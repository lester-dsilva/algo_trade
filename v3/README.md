# v3 — Hourly Volume-Breakout Swing Strategy

Swing trading strategy separate from v2 intraday. Screens high-momentum stocks on the **daily** chart, enters on **hourly** volume breakouts near the 20 EMA, and holds for days/weeks until trend breaks or trail stop hits.

## Quick start

```bash
# 0. Load history for your watchlist (config/v3_watchlist.txt)
npm run v3:fetch:watchlist

# 1. Fetch one symbol
node v3/scripts/fetchV3Data.js --symbol INOXINDIA

# 2. Run backtest
node v3/scripts/runBacktest.js --symbol INOXINDIA --verbose

# 3. Live paper trading (same rhythm as v2)
npm run kite:session          # refresh Kite token if needed
npm run v3:scan:premarket     # ~8:45 AM — refresh watchlist CSV data (optional)
npm run v3:scan:hourly        # each hour — entry checks on full watchlist
npm run v3:scan:exits         # ~3:35 PM — exit open swing positions
npm run v3:scan:daemon        # schedule all tasks
```

Watchlist: `config/v3_watchlist.txt` (one symbol per line). Override with env `V3_WATCHLIST_PATH`.

## Data layout

```
v3/data/daily/<symbol>.csv     # 220 days daily OHLCV
v3/data/hourly/<symbol>.csv    # 90 days 60-minute OHLCV
data/swing_positions.json      # open/closed swing paper positions (if V3_TRACK_POSITIONS=true)
```

CSV format: `date,time,open,high,low,close,volume` (see [DATA_FORMAT.md](../DATA_FORMAT.md)).

## Strategy flow

1. **Watchlist** — `config/v3_watchlist.txt` symbols scanned each hour
2. **Breadth gate** — skip entries when &lt;50% of watchlist is above 20d SMA (`V3_BREADTH_FILTER=false` to disable)
3. **Hourly entry** — breakout + volume + SMA checks all at entry bar (daily SMA uses entry price)
4. **Swing exit** — fixed **2.5% SL** and **10% target** on hourly bars (multi-day hold)

Full rules: [docs/V3_ENTRY_RULES.md](../docs/V3_ENTRY_RULES.md)

## vs v2

| | v2 (intraday) | v3 (swing) |
|---|---|---|
| Timeframe | 3-minute | 60-minute |
| Hold | Same day (EOD exit) | Days to weeks |
| Screen | Per-bar on full universe | Full watchlist, checks at entry bar |
| Positions | `data/positions.json` | `data/swing_positions.json` |

## npm scripts

```bash
npm run v3:fetch -- --symbol INOXINDIA
npm run v3:fetch:watchlist
npm run v3:backtest -- --symbol INOXINDIA --verbose
npm run v3:scan:premarket
npm run v3:scan:hourly
npm run v3:scan:exits
```

## Env

- Kite credentials (same as v2): `.env` with `KITE_API_KEY`, `KITE_ACCESS_TOKEN`
- Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- Optional: `V3_KITE_HISTORICAL_RPS=3` (API rate limit)
- Optional: `V3_TRACK_POSITIONS=true` to persist paper positions (default: **Telegram alerts only**)
