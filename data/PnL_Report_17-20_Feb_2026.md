# Backtest P&L Report — 17–20 Feb 2026

**Strategy:** Reversal breakout entry | Consolidation 2+ bars near 20 EMA | **Entry bar green** | ₹30,000 per trade | First target 3% then trail 1.5% | EOD 15:25  
**Source:** `scripts/analyzePnl.js` (same logic as live scanner)

---

## Summary

| Date       | Trades | Stop | EOD | Total P&L    | Capital deployed |
|------------|--------|------|-----|--------------|------------------|
| 2026-02-17 | 2      | 0    | 2   | **₹-273.66** | ₹59,987          |
| 2026-02-18 | 11     | 6    | 5   | **₹7,844.98**| ₹3,13,052        |
| 2026-02-19 | 2      | 2    | 0   | **₹2,073.28**| ₹59,590          |
| 2026-02-20 | 7      | 3    | 4   | **₹1,361.28**| ₹2,02,802        |
| **Total**  | **22** | **11**| **11** | **₹11,006.88** | —             |

---

## 17 Feb 2026

| Symbol   | Time   | Entry  | Exit | Exit price | P&L      |
|----------|--------|--------|------|------------|----------|
| UCOBANK  | 10:54  | 29.15  | eod  | 28.93      | -226.38  |
| CENTRALBK| 10:51  | 38.06  | eod  | 38.00      | -47.28   |

**Total P&L: ₹-273.66**

---

## 18 Feb 2026

| Symbol    | Time  | Entry   | Exit | Exit price | P&L     |
|-----------|-------|---------|------|------------|---------|
| GODFRYPHLP| 10:57 | 2312.70 | eod  | 2478.90   | 1994.40 |
| RATNAMANI | 10:21 | 2312.50 | stop | 2491.95   | 2153.40 |
| E2E       | 10:27 | 2629.00 | stop | 2893.24   | 2906.64 |
| IZMO      | 10:51 | 848.70  | stop | 869.76    | 737.10  |
| TARIL     | 10:33 | 300.00  | stop | 294.82    | -518.00 |
| SCHNEIDER | 10:36 | 923.95  | eod  | 915.50    | -270.40 |
| APARINDS  | 10:54 | 10019.00| stop | 10267.15  | 496.30  |
| KRN       | 10:48 | 774.25  | eod  | 788.30    | 533.90  |
| HEG       | 11:18 | 554.95  | eod  | 553.00    | -105.30 |
| SAMBHV    | 10:33 | 101.67  | eod  | 102.61    | 277.30  |
| EDELWEISS | 10:30 | 129.61  | stop | 128.05    | -360.36 |

**Total P&L: ₹7,844.98**

---

## 19 Feb 2026

| Symbol   | Time  | Entry  | Exit | Exit price | P&L     |
|----------|-------|--------|------|------------|---------|
| NEWGEN   | 10:57 | 607.40 | stop | 627.94    | 1006.46 |
| NITINSPIN| 10:24 | 363.75 | stop | 376.76    | 1066.82 |

**Total P&L: ₹2,073.28**

---

## 20 Feb 2026

| Symbol     | Time  | Entry   | Exit | Exit price | P&L     |
|------------|-------|---------|------|------------|---------|
| ABB        | 10:21 | 6059.00 | stop | 6151.33   | 369.32  |
| STANLEY    | 11:48 | 177.50  | stop | 174.53    | -501.93 |
| ABINFRA    | 10:33 | 21.74   | stop | 22.10     | 496.44  |
| BDL        | 10:30 | 1317.20 | eod  | 1308.50   | -191.40 |
| BALAJITELE | 10:33 | 98.50   | eod  | 99.89     | 422.56  |
| AURUM      | 10:42 | 185.20  | eod  | 187.39    | 352.59  |
| YATHARTH   | 11:12 | 710.70  | eod  | 720.55    | 413.70  |

**Total P&L: ₹1,361.28**

---

*Report from `data/baselines/2026-02-{17,18,19,20}/pnl.json`. Entry bar must be green (close > open).*
