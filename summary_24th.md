# Codebase Summary — Feb 24, 2026

## Directory Structure

```
stocks/
├── lib/
│   ├── entryLogic.js       ← Core signal detection (the main one)
│   ├── kite.js             ← Kite auth + client
│   ├── candleBuilder.js    ← Builds 3m bars from live ticks
│   ├── positionStore.js    ← Paper position JSON persistence
│   └── telegram.js         ← Telegram alert sender
├── scripts/
│   ├── analyzePnl.js       ← Backtest / PnL simulation
│   ├── liveScanner.js      ← Live market scanner via WebSocket
│   ├── findEntries.js      ← Find entries from CSV files
│   ├── positionManager.js  ← Monitor open positions, exit logic
│   ├── kiteOHLC.js         ← Fetch OHLC from Kite API
│   ├── kiteLogin.js        ← Kite login helper
│   ├── analyzeReward.js    ← Reward analysis (4.5% target)
│   ├── analyzeVolume.js    ← Volume analysis
│   └── buildWatchlistFromMcap.js
├── data/
│   ├── baselines/YYYY-MM-DD/   ← watchlist.txt + pnl.json per run
│   ├── watchlists/YYYY-MM-DD/  ← watchlist.txt per date
│   ├── YYYY-MM-DD/             ← {symbol}.csv (3m OHLC per day, cached)
│   ├── positions.json
│   ├── watchlist_23.txt        ← default watchlist for analyzePnl
│   └── live_scanner.log
├── config/
│   └── nse_mcap_above_900cr.csv ← watchlist for liveScanner
└── .env
```

---

## entryLogic.js — Full Deep Dive

Three strategies exported; `REVERSAL_BREAKOUT` is the main one used everywhere.

### 1. `findBreakoutsOnePerDay` — Triangle Breakout
- Sliding window of `lookback` (default 15) bars
- Computes high/low/range% of the window
- If `rangePct <= maxRangePct (2%)` → tight consolidation
- If current bar closes above consolidation high → breakout signal
- One signal per day (deduped by date)

### 2. `findPullbacks` — Pullback to 20 EMA
- Calculates EMA20 on closes for each day
- Tracks `highSoFar` from open; needs ≥0.5% move from open first
- Signal if: close within `tolerancePct (1%)` of EMA20, OR bar undercuts EMA but closes back above
- Max 2 per day, requires ≥20 bars elapsed (EMA warmup)

### 3. `findReversalBreakouts` — The Main Strategy

**Pattern (all 4 steps required):**
1. **Sharp move**: Price runs ≥4% from day open within first 60 bars (~3 hours)
2. **Pullback to EMA**: After the move, price pulls back to/near 20 EMA (within `pullbackNearPct=2%`), OR bar range straddles EMA (`low ≤ EMA*1.02 AND high ≥ EMA*0.98`)
3. **Consolidation**: ≥2 contiguous bars near EMA — tracks `consHigh`, `consLow`, `consVolumeSum`
4. **Breakout**: Bar closes above `consHigh` AND above EMA20

**Filters applied in order (each can `onSkip`):**

| Filter | Default (.env) | Env var |
|--------|---------------|---------|
| Gap up filter | 2% | `GAP_UP_THRESHOLD_PCT` |
| Green candle (close > open) | always | — |
| Entry candle range % | 2% | `MAX_ENTRY_CANDLE_RANGE_PCT` |
| SL % (entry - consLow*0.995) / entry | 3% | `MAX_SL_PCT` |
| Volume: today cumVol > prev day full vol | always | — |
| Pullback % from move high to pullback low | 5% | `MAX_PULLBACK_PCT` |
| Consolidation range % (consHigh-consLow)/consHigh | 2% | `MAX_CONSOLIDATION_RANGE_PCT` |
| Volume ratio (entryBarVol / consAvgVol) | disabled | `MIN_VOLUME_RATIO` |

**Output per signal:**
```js
{
  type: 'REVERSAL_BREAKOUT',
  date, time, timeIST,
  close,                   // entry price = breakout bar close
  ema20,
  consHigh,                // consolidation high
  suggestedStop,           // consLow * 0.995
  entryBarVolume,
  consolidationAvgVolume
}
```

**Key implementation details:**
- SL placed below **consolidation low** only (NOT day low — day low can be from the open and would make SL invalid)
- Gap uses `getDayOpenDaily()` (from daily API) vs `getPrevDayCloseDaily()` — NOT the 3m first bar open
- In `liveScanner`, today's open fetch is deferred until 9:20 AM IST so the day candle is stable
- Volume filter: cumulative volume bars 0..i on entry day must ALREADY exceed prev trading day's **full** volume
- After breakout found, `break` — only one signal per day per symbol

**`refineWith1m(date, time3m, byDateLtf)`:**
- Given a 3m signal time, finds the first 1m bar within that 3m window where `close > EMA20`
- Used by `findEntries.js` for more precise entry timing

**`runEntryLogic(byDate, sortedDates, options)`:**
- Orchestrates all three detectors
- Returns `{ breakouts, pullbacks, reversalBreakouts }`
- All option defaults: `lookback=15, maxRangePct=2, tolerancePct=1, sharpMovePct=4, pullbackNearPct=2, maxPerDay=2, maxGapUpPct=null, maxEntryCandleRangePct=1.5, maxSlPct=2, maxPullbackPct=5, maxConsolidationRangePct=2`

---

## Running PnL Analysis (analyzePnl.js)

```bash
# For a specific date (uses entry logic + same filters as liveScanner)
node scripts/analyzePnl.js 2026-02-20

# For today (IST)
node scripts/analyzePnl.js --today

# With a custom watchlist file
node scripts/analyzePnl.js 2026-02-20 --watchlist data/watchlists/2026-02-20/watchlist.txt

# Use reward watchlist (data/watchlist_reward.txt)
node scripts/analyzePnl.js 2026-02-20 --reward

# Just load/cache 3m data, don't run PnL
node scripts/analyzePnl.js 2026-02-20 --load-only

# From a log file (no volume filter, simpler path)
node scripts/analyzePnl.js data/live_scanner.log
```

**Execution flow for a date:**
1. Load watchlist (`data/watchlist_23.txt` by default)
2. For each symbol: fetch daily OHLC (7 days back) → `prevDayCloseDaily`, `dayOpenDaily` for gap filter
3. Fetch 3m data for `prevTradingDate` + `forDate` (checks `data/YYYY-MM-DD/{symbol}.csv` first; calls Kite API + caches if missing)
4. Run `findReversalBreakouts` with all filters
5. Simulate trades (see Trade Simulation below)
6. Print P&L table, save baseline to `data/baselines/YYYY-MM-DD/pnl.json` + `watchlist.txt`

**Watchlist resolution order:**
1. `--watchlist <path>` → that file
2. `--reward` → `data/watchlist_reward.txt`
3. default → `data/watchlist_23.txt` (falls back to `watchlist_reward.txt`)

**Trade Simulation (`simulateTrade`):**
- Position size: ₹30,000 per entry (`qty = floor(30000 / entryPrice)`)
- Entry: the breakout bar's close price, at that bar's time
- First target: `entry * 1.03` — does NOT exit here, just flags `hitFirstTarget`
- After 3% hit: trail `highWaterMark * 0.985` — exit when bar **closes** ≤ trail level (not intrabar low)
- Before 3% hit: exit when bar **low** ≤ stop
- EOD: forced exit at 15:24 bar close
- Target column in output: `entry + 2 * risk` (2R target, for reference only)

**Caching:** `loadOrFetch()` checks `data/YYYY-MM-DD/{symbol}.csv` first. If found, uses it directly. Otherwise calls Kite API and writes result back. Makes re-runs fast.

---

## Running Live Scanner (liveScanner.js)

```bash
node scripts/liveScanner.js
# or
npm run live
```

**Startup sequence:**
1. Load `config/nse_mcap_above_900cr.csv` → symbols (max 3000)
2. Fetch instrument tokens from Kite instruments list
3. Fetch prev day close + full volume from daily API for all symbols (batches of 15, concurrent)
4. If before 9:20 IST → defer today's open fetch; else fetch immediately
5. Load session from `.kite_session`, connect `KiteTicker` WebSocket
6. Subscribe all tokens in `modeFull`

**Per tick:**
- `candleBuilder.addTick(token, symbol, price, qty, timestamp)` → emits completed 3m bar
- On bar close: run `runEntryLogic` with prev day data injected via `getPrevDayVolume`, `getPrevDayCloseDaily`, `getDayOpenDaily` callbacks
- Apply `MIN_VOLUME_RATIO` post-filter if set
- New signal → `positionStore.addPosition()` → `logToFile('signal', {...})` → `sendAlert()` to Telegram
- Deduped by `symbol|date|type|time` key

**Heartbeat:** every 5 min logs `bars=X symbols=Y ticks=Z` to console + log file

**Log format (`data/live_scanner.log`):**
```
24/2/2026, 09:15:00	signal	{"symbol":"RELIANCE","date":"2026-02-24","time":"09:18:00","entry":2500,"stop":2450,"target":2600}
24/2/2026, 09:15:00	skip	{"symbol":"INFY","date":"...","time":"...","reason":"gap 3.2% >= 2%"}
24/2/2026, 09:10:00	heartbeat	"bars=150 symbols=42 ticks=12000"
```

---

## Current .env Settings

```
KITE_API_KEY=zudiz8rwc3qezgj4
KITE_API_SECRET=t8e1nexppz03ski4fyelwh76hgm2d24i
TELEGRAM_BOT_TOKEN=6646802733:AAHMpJ2EotGObbaRPUGAJt3aNkKf9M3eaOY
TELEGRAM_CHAT_ID=-722007173
LIVE_TRADING=false
GAP_UP_THRESHOLD_PCT=2
MAX_ENTRY_CANDLE_RANGE_PCT=2
MAX_SL_PCT=3
MAX_PULLBACK_PCT=5
MAX_CONSOLIDATION_RANGE_PCT=2
LIVE_SCANNER_LOG=1
LOG_PATH=data/live_scanner.log
# MIN_VOLUME_RATIO not set → disabled
# LOAD_DELAY_MS not set → default 1000ms
```

---

## Data Flow

```
Live:
  Kite WS ticks
    → candleBuilder (builds 3m bars)
    → entryLogic (runEntryLogic)
    → signal
    → positionStore.addPosition() + logToFile() + sendAlert()
  (prev day vol/close prefetched from daily API at startup)

Backtest:
  watchlist
    → Kite daily API (prevClose, dayOpen for gap filter)
    → Kite 3m API (cached to data/YYYY-MM-DD/{symbol}.csv)
    → findReversalBreakouts (all filters)
    → simulateTrade (3% target, 1.5% trail, EOD 15:24)
    → data/baselines/YYYY-MM-DD/pnl.json
```

---

## Key Numbers

| Thing | Value |
|-------|-------|
| Sharp move threshold | ≥4% from open |
| Sharp move window | first 60 bars (~3 hours of 3m) |
| EMA period | 20 |
| Consolidation min bars | ≥2 contiguous near EMA |
| Position size | ₹30,000 per trade |
| First target trigger | +3% from entry |
| Trail after 3% hit | 1.5% below high watermark (on close) |
| EOD exit bar | 15:24 close |
| Gap filter (current .env) | ≥2% gap up → skip |
| SL filter (current .env) | >3% of entry → skip |
| Entry candle range (current .env) | >2% → skip |
| Max pullback (current .env) | >5% → skip |
| Max consolidation range (current .env) | >2% → skip |
| Volume ratio filter | disabled (MIN_VOLUME_RATIO not set) |
| Kite WebSocket max tokens | 3000 |
| Daily API fetch concurrency | 15 |
| Today open deferred until | 9:20 IST |

---

## Other Scripts

| Script | Usage |
|--------|-------|
| `node scripts/kiteOHLC.js NSE:SYMBOL 3minute YYYY-MM-DD YYYY-MM-DD [out.csv]` | Fetch OHLC from Kite |
| `node scripts/findEntries.js [csvPath] [--ltf=1m.csv]` | Find entries from CSV, optional 1m refinement |
| `node scripts/positionManager.js [intervalSeconds]` | Poll positions.json, check stops/targets, send alerts (0 = one-shot) |
| `node scripts/analyzeReward.js [from] [to] [--reload]` | Analyze with 4.5% target |
| `node scripts/analyzeVolume.js [from] [to]` | Compare volume winners vs losers |
| `node scripts/buildWatchlistFromMcap.js` | Filter NSE symbols by market cap ≥900 Cr |
| `npm run live` | Alias for `node scripts/liveScanner.js` |
