# PRAJIND NSE — Where to enter (pullback to 20 EMA)

Data: 3m bars, 2026-02-10 to 2026-02-18. Strategy: flag/breakout, pullback to or undercut of 20 EMA, then 1:2 target and trail.

---

## Best entry zones (by day)

### 2026-02-10 (Monday)
- **Open:** 301 (gap up from prior ~295). Strong surge to 321+ in first 30 min.
- **Pullback:** Price came back to 313–315; several bars touched/near 20 EMA.
- **Suggested entry:** **~10:33–10:45 IST** at **313.8–315** (close was 313.8, EMA 313.92 at 10:33 IST). Undercut bars at 10:15 IST (314.4), 10:21 (314.35), 10:45 (315.2).
- **Stop:** Below the pullback low (e.g. under 312).
- **What happened:** Price ran to 330+ then 335+ — pullback held; 1:2 and trail would have worked.

### 2026-02-17 (Monday)
- **Open:** 323 (already +7.87% from prior close). Continued strength.
- **First pullback:** **~11:00–11:30 IST** at **324–325**. Bar at 11:00 IST: close 324.85, EMA 324.76 (undercut). Bar at 11:30: close 324.25, undercut.
- **Suggested entry:** **~11:00 IST at 324–325** (first pullback to EMA after the open drive).
- **Second zone:** **~13:30 IST at 335** (price sat on EMA at 335.15).
- **Stop:** Below 323 (pullback low) for first entry; below 333 for second.
- **What happened:** After 11:30, price ran to 333+ then 339+; later in the day it gave back some. First entry (11:00 @ 324) would have caught the move; 1:2 then trail.

### 2026-02-09 (prior week)
- **Open:** 287. Move to 302+ then pullback to 298–300.
- **Suggested entry:** **~11:30 IST at 298** (close 298, EMA 297.34, 0.22% away). Or **12:39–13:00 IST at 299.5–299.8** (very close to EMA after the dip from 302).
- **Note:** 11:30 @ 298 was a clean “sweet” zone (tight to EMA, after the run). Price later made 301+ then faded into close.

### 2026-02-16
- **Low momentum** from open (move from open only ~1.27%). Many bars near EMA in the 14:00–15:30 IST range around 303. Less ideal per our “high momentum” filter; can skip or take only with strict risk.

---

## Summary

| Date       | Suggested entry (IST) | Price zone | Note                          |
|------------|------------------------|------------|-------------------------------|
| 2026-02-10 | **10:33–10:45**        | **313.8–315** | First pullback after big surge; held, ran to 330+ |
| 2026-02-17 | **11:00–11:30**        | **324–325**  | First pullback to EMA; undercut, then run to 333+ |
| 2026-02-09 | **11:30**              | **~298**     | Tight to EMA after run to 302; undercut at 11:27/12:00 |

**Rule of thumb:** Enter when price pulls back to within ~1% of 20 EMA (or undercuts then closes back above) *after* at least ~0.5% move from open. Prefer the **first** such zone in the 10:00–12:00 IST window. Stop below the pullback low or below 20 EMA.

Data and full bar list: run  
`node scripts/findEntries.js data/prajind.csv --tolerance=2`
