# Long-term objective & strategy

## What we want to achieve

- **Intraday-only trading tool** — no overnight positions; everything is squared off by end of day.
- **Desktop app** — Electron app that uses Zerodha Kite for data and (optionally) order execution.
- **Data-driven edge** — use historical analysis and backtests to reduce noise and only take setups that have shown a real edge (e.g. 1:2 RR with trailing potential).
- **Workflow** — scan for setups, get alerts or suggested entries when conditions match, manage positions (1:2 target then trail) within the same session.

---

## Strategy (how we trade)

### Setup

- **Pattern:** Flags / triangles — consolidation after a strong move, then breakout; or **reversal breakout** — gap down then first close above 20 EMA.
- **Trigger:** Breakout of the triangle (or flag), or **reversal breakout** (gap down, then cross above 20 EMA with volume).
- **Entry:** Prefer **pullback to or slight undercut of the 20 EMA** after the breakout (“sweeter” entry); or enter on **reversal breakout** (first close above EMA after gap down). Primary TF 3m; optional 1m for refining exact bar.
- **Universe:** **High momentum stocks** only — we want names that can move; the tool will filter or rank by momentum (e.g. % from open, volume, range).
- **Timeframe:** Intraday (e.g. 3m, 5m, 15m); all analysis and trades within the session.

### Targets & risk

- **First target:** **1:2 risk–reward** — take partial or move stop to breakeven when price reaches 2× risk.
- **Then:** **Trail** — trail stop (e.g. under swing lows or under 20 EMA) to lock profit and let winners run; no fixed 5R requirement, but we want the *option* to capture extended moves.
- **Stop:** Below the flag/triangle or below the pullback low (or under the EMA undercut by a defined amount).

### Reducing noise

- **Study past moves** — use historical OHLC (e.g. from Kite) and Node.js analysis scripts to:
  - Find days/symbols where the “flag + breakout + pullback to EMA” setup occurred.
  - Measure outcomes: did price reach 2R? How often did the pullback “hold” vs fail (e.g. 17th vs 16th style)?
- **Refine rules** — tighten filters (momentum threshold, time window, volume, flag duration) so we take fewer but higher-quality trades.
- **Backtest** — encode entry/exit rules and run on history to validate before going live.

---

## How the project supports this

| Layer | Purpose |
|-------|--------|
| **Data** | Kite APIs: OHLC (historical + live), instruments, quotes. Scripts: `kiteOHLC.js` (date range + interval), `loadCsv.js` for our CSV format. |
| **Analysis** | Node scripts: EMA, momentum, findEntries (triangle breakout, pullback to EMA, **reversal breakout**). Primary TF 3m; optional --ltf for 1m refinement. Later: 1:2 + trail simulation. |
| **Backtest / study** | Run strategy logic on historical data; output stats (win rate, avg RR, drawdown) to refine the setup. |
| **App (later)** | Electron app: watchlist, charts (e.g. 20 EMA), alerts when setup conditions hit, paper/real orders via Kite, position management (1:2 then trail). |

---

## Summary

- **Objective:** An intraday-only desktop tool (Electron + Kite) that finds and trades flag/triangle breakouts with a pullback to the 20 EMA in high-momentum stocks, targeting 1:2 then trailing.
- **Strategy:** Flags/triangles, breakout entry preferred on pullback to/undercut of 20 EMA, 1:2 first target then trail, high momentum only.
- **Path:** Data (Kite + scripts) → analysis & backtest (Node.js) → refine rules → then build the app and (optionally) automate alerts/execution.
