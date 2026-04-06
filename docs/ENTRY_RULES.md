# Trade entry rules

Summary of the v2 entry logic: **3m breakout after 4% move + pullback/consolidation**.  
Defined in `v2/lib/entryLogic.js` (configurable via baseline config in the dashboard).

---

## Preconditions (day / symbol)

| Rule | Value | Description |
|------|--------|-------------|
| **Gap up max** | 3% | Day open vs previous close — no entry if gap up &gt; 3%. |
| **First-hour move** | ≥ 4% | In the first ~60 min (9:15–10:15), high must be at least 4% above day open. |

---

## When we look for entry

- **Entry window:** From bar 20 (10:18) until **12:30** — no new entries after 12:30.
- **Structure (one of):**
  - **Pullback:** At some point after the first hour, low was at least **1%** below the first-hour high.
  - **Consolidation:** Last 5 bars’ range ≤ **2%** of price.
- **Pullback cap:** If there was a pullback from the day high, it must not exceed **4%** from the day’s high so far.
- **Not overstretched:** Price at this bar must not be more than **14%** above day open.

---

## The entry candle (breakout bar)

| Rule | Value | Description |
|------|--------|-------------|
| **New high close** | — | Candle must close above the day’s high so far (breakout). |
| **Breakout strength** | ≥ 0.4% | Close must be at least 0.4% above the recent (last 5 bars) high. |
| **Bullish** | — | Close &gt; open. |
| **Wicks** | ≤ 35% each | Upper and lower wick each ≤ 35% of the candle’s range. |
| **Day volume** | ≥ 1.5× prorated prev | Cumulative volume up to this bar ≥ `dayVolMult` × (prev day volume × elapsed/375), where elapsed is minutes since 09:15 in a 375-minute session (09:15–15:30). |
| **Bar volume** | ≥ 1.1× avg(prev 5) | This bar’s volume ≥ 1.1× average of the previous 5 bars. |

---

## Risk (set at entry)

| Rule | Value |
|------|--------|
| **Stop loss** | Fixed **1.5%** below entry. |

---

## Exit (not part of entry logic)

- **First target:** 3% above entry (then trail).
- **Trail:** 1.5% below high water mark after first target.
- **EOD:** Exit at 15:24 if still open.

---

## Configurable parameters (baseline config)

When creating a baseline from the dashboard, you can override:

- **Entry — volume:** `dayVolMult` (default 1.5, time-adjusted vs prorated prev-day volume), `breakoutVolMult` (default 1.1)
- **Entry — other:** `gapUpMaxPct`, `moveUpMinPct`, `pullbackPct`, `pullbackMaxFromTopPct`, `wickMaxPct`, `consolidationRangePct`, `maxEntryTime`, `fixedSlPct`, `maxDayMovePct`, `breakoutStrengthMinPct`
- **Exit:** `firstTargetPct` (default 3), `trailPct` (default 1.5)
