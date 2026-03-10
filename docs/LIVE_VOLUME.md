# Why live 3m bar volume is much lower than exchange volume

## What you saw: APOLLOPIPE 12:21 bar

| Source | 12:21 bar volume | Prev 5 bars avg vol | Ratio (bar / avg5) |
|--------|------------------|---------------------|--------------------|
| **Exchange** (Kite historical 3m CSV) | **328,367** | 158,690 | 2.07× ✓ |
| **Live** (ticks in scanner log) | **26,264** | 16,523 | 1.59× ✗ |

The live scanner only had **26,264** for the 12:21 bar, so the 2× breakout-volume rule failed and no entry was taken. The exchange bar had **328,367** — about **12.5× higher**.

## Root cause (old behaviour): summing last_traded_quantity

- Kite docs and forums state: **do not sum `last_traded_quantity`** across ticks — it significantly undercounts. The tick stream is snapshot/L2 data; not every trade is a separate tick.
- The **correct** way (per Kite) is to use the **cumulative “volume traded for the day”** field (`volume` in the tick) and set **bar volume = (last tick’s cumulative volume in the bucket) − (first tick’s cumulative volume in the bucket)**.

## What we changed (volume logic)

1. **`lib/candleBuilder.js`**  
   - Bar volume is now computed from **cumulative volume difference**: for each 3m bucket we store the first tick’s `volume` (day cumulative) and update the last tick’s `volume` on every tick in that bucket; when the bar is flushed we use `volume = lastCum − firstCum`.  
   - If `volumeCumulative` is not passed (optional 6th argument), we fall back to summing `quantity` (old behaviour).

2. **`scripts/liveScanner.js`**  
   - Passes `t.volume` (Kite’s “volume traded for the day”) as the 6th argument to `addTick`, so the builder can use the cumulative-diff method.

This matches Kite’s recommended approach and should bring live bar volume much closer to exchange volume (and to historical 3m API).

## If you need true volume in live

- **Option A:** Keep using `liveMode: true` (current behaviour) so the 2× rule doesn’t block entries; volume is still “relative” (bar vs avg5).
- **Option B:** After each 3m bar closes, **fetch that bar from Kite historical 3m API** for the symbols you care about and run entry logic on that bar (exchange volume). That adds latency and API usage.
- **Option C:** Subscribe to fewer symbols so you get a higher fraction of ticks per symbol (still sampled, but possibly closer to reality).

## Reference: APOLLOPIPE 2026-03-09 (exchange vs live)

Exchange 3m (from `v2/data/2026-03-09/3m/apollopipe.csv`):

- 12:06 → 192,038  
- 12:09 → 170,607  
- 12:12 → 76,965  
- 12:15 → 218,273  
- 12:18 → 135,568  
- **12:21 → 328,367**

Live (from `data/live_scanner.log`):

- 12:06 → 13,356  
- 12:09 → 18,871  
- 12:12 → 19,501  
- 12:15 → 18,367  
- 12:18 → 12,521  
- **12:21 → 26,264**

So live captured roughly **8–12%** of exchange volume per bar that day.
