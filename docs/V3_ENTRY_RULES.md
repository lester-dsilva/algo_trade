# v3 trade entry and exit rules

Hourly volume-breakout swing strategy. Logic in `v3/lib/`.

---

## Stage 1: Watchlist + breadth gate

Symbols in `config/v3_watchlist.txt` are scanned each hour.

**Breadth filter (default ON):** skip all new entries when **&lt;50%** of the watchlist has its last completed daily close **above 20d SMA**. Uses prior completed days only (no lookahead). Disable with `V3_BREADTH_FILTER=false` or backtest `--no-breadth`. Threshold: `V3_BREADTH_MIN_PCT=50`.

---

## Stage 2: Hourly entry (all checks at entry bar)

One entry per day max. **Daily and hourly SMA** are both evaluated using the **entry bar close** vs completed history — not yesterday's close.

### Breakout candle

| Rule | Default | Description |
|------|---------|-------------|
| N-bar high break | 12 bars | Close above highest high of prior 12 hourly bars |
| Bullish | required | Close > open |
| Volume | ≥ **5×** avg(prev 60) | Volume spike vs ~2.5 weeks of hourly baseline |
| Upper wick | ≤ 30% of range | No rejection wick at resistance |
| Close position | upper 65% of bar | Close near highs, not mid-candle fade |
| Resistance break | close > **60-bar** high | Must clear wider resistance zone (~1.5 weeks), not just recent 3-day range |
| Strength | ≥ 0.2% above range high | Meaningful breakout |
| Candle range | ≤ **7%** of close | Skip oversized hourly spike candles |
| Entry vs hourly SMA | **-1% to +12%** of **20-bar hourly SMA** | Near short-term mean at entry — not a chase |
| Entry vs daily SMA | **-1% to +12%** of **20d SMA** (completed days only) | Uses entry price, not prior close |
| Entry-day volume | **scaled by hour** (cap **2×**) | Sum hourly vol 09:15→entry bar vs avg(prev **10** daily bars). Min: **0.75×** at 09:15, **+0.75×** each hour (**1.5×** at 10:15, **2×** from 11:15 onward) |

### Risk

| Rule | Default |
|------|---------|
| Stop | **2.5%** below entry (fixed) |
| Target | **10%** above entry (fixed) |

---

## Exit rules

| Exit | Rule |
|------|------|
| Stop | Hourly bar **low** ≤ entry − 2.5% |
| Target | Hourly bar **high** ≥ entry + 10% |
| EMA exit | **2H close** ≤ 2H EMA(20) − 1% |
| Max hold | 30 trading days (safety cap) |
| End of data | Exit at last bar close if still open |

2H candles are built from hourly pairs within each session (09:15+10:15 → close 10:15, etc.).

Configurable via `EXIT_DEFAULTS` in `v3/lib/swingExitLogic.js`.

---

## INOX India example

The two marked entries on the daily chart (~1400 in June, ~1950 in August) share:

1. Strong uptrend above 20d SMA
2. Pullback/consolidation near 20d SMA
3. Volume-backed breakout on hourly

Run backtest to validate:

```bash
node v3/scripts/fetchV3Data.js --symbol INOXINDIA
node v3/scripts/runBacktest.js --symbol INOXINDIA --verbose
```

Tune `breakoutVolMult`, `consolidationLookback`, and `emaProximityMaxPct` if entries are early/late vs chart marks.
