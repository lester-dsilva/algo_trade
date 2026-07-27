/**
 * Study: do fuck3 trades fail on red NIFTY days?
 * "Red/green" is measured vs the PREVIOUS DAY'S CLOSE (the correct, gap-aware definition),
 * NOT vs today's open. Joins each baseline trade to NIFTY hourly data and reports outcomes by:
 *   (A) Nifty FINAL day color/magnitude vs prev close   (descriptive — uses today's close)
 *   (B) Nifty state AT THE ENTRY HOUR vs prev close      (actionable — no lookahead)
 *   (G) the opening GAP alone (known at 09:15)           (actionable — pure gap signal)
 *
 * Run: node scripts/studyNiftyRegime.js [baseline=fuck3]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'v2', 'data');
const baseName = process.argv[2] || 'fuck3';
const idxFile = process.argv[3] || 'nifty_hourly.json';
const idxLabel = idxFile.replace('_hourly.json', '').toUpperCase();

const baseline = JSON.parse(fs.readFileSync(path.join(DATA, 'backtest_baselines', `${baseName}.json`), 'utf8'));
const nifty = JSON.parse(fs.readFileSync(path.join(DATA, idxFile), 'utf8'));

// ---- build per-day Nifty model with PREV-CLOSE reference ----
const byDay = {};
for (const r of nifty.candles) (byDay[r.date] = byDay[r.date] || []).push(r);
const dates = Object.keys(byDay).sort();
const toMin = (t) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
const niftyDay = {}; // date -> { prevClose, open, close, gapPct, dayChgPct, bars }
for (let k = 0; k < dates.length; k++) {
  const date = dates[k];
  const bars = byDay[date].slice().sort((a, b) => a.time.localeCompare(b.time));
  const open = bars[0].open;
  const close = bars[bars.length - 1].close;
  const prevDate = dates[k - 1];
  const prevClose = prevDate ? niftyDay[prevDate]?.close ?? byDay[prevDate].slice().sort((a, b) => a.time.localeCompare(b.time)).pop().close : null;
  niftyDay[date] = {
    prevClose, open, close,
    gapPct: prevClose ? ((open - prevClose) / prevClose) * 100 : null,
    dayChgPct: prevClose ? ((close - prevClose) / prevClose) * 100 : null,
    bars: bars.map((b) => ({ tmin: toMin(b.time), open: b.open, high: b.high, low: b.low, close: b.close })),
  };
}

// Nifty % vs PREV CLOSE at the hourly bar covering entryMin (no lookahead).
function niftyAtEntry(date, entryMin) {
  const d = niftyDay[date];
  if (!d || d.prevClose == null) return null;
  let bar = d.bars[0];
  for (const b of d.bars) { if (b.tmin <= entryMin) bar = b; else break; }
  return ((bar.close - d.prevClose) / d.prevClose) * 100;
}

// ---- helpers ----
const isWin = (t) => t.pnl > 0;
const isStop = (t) => t.exitReason === 'stop';
function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winPct: 0, stopPct: 0, pnl: 0, perTrade: 0 };
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  return { n, winPct: (100 * trades.filter(isWin).length) / n, stopPct: (100 * trades.filter(isStop).length) / n, pnl, perTrade: pnl / n };
}
function printBucket(label, trades) {
  const s = summarize(trades);
  console.log(`${label.padEnd(22)} | ${String(s.n).padStart(5)} | ${s.winPct.toFixed(1).padStart(5)} | ${s.stopPct.toFixed(1).padStart(5)} | ${('₹' + Math.round(s.pnl).toLocaleString('en-IN')).padStart(11)} | ${String(Math.round(s.perTrade)).padStart(6)}`);
}
const HEAD = `${'bucket'.padEnd(22)} | ${'n'.padStart(5)} | ${'win%'.padStart(5)} | ${'stop%'.padStart(5)} | ${'totalPnl'.padStart(11)} | ${'₹/trd'.padStart(6)}`;
const RULE = '-'.repeat(HEAD.length);

// ---- attach nifty context to each trade ----
const trades = [];
let missing = 0;
for (const t of baseline.trades) {
  const d = niftyDay[t.date];
  if (!d || d.prevClose == null) { missing++; continue; }
  trades.push({ ...t, gapPct: d.gapPct, niftyDayChg: d.dayChgPct, niftyAtEntry: niftyAtEntry(t.date, toMin(t.time)) });
}
console.log(`\nbaseline=${baseName}  trades=${baseline.trades.length}  matched=${trades.length}  missing=${missing}   [reference = PREVIOUS DAY CLOSE]`);
console.log(HEAD); console.log(RULE); printBucket('ALL', trades);

// ================= (A) FINAL DAY COLOR vs prev close =================
console.log(`\n(A) by NIFTY FINAL day color vs prev close  [descriptive]`);
console.log(HEAD); console.log(RULE);
printBucket('GREEN day (>0)', trades.filter((t) => t.niftyDayChg > 0));
printBucket('RED day (<0)', trades.filter((t) => t.niftyDayChg < 0));

console.log(`\n(A2) by NIFTY day magnitude vs prev close`);
console.log(HEAD); console.log(RULE);
for (const [lbl, fn] of [
  ['<= -1.0%', (c) => c <= -1.0], ['-1.0..-0.5%', (c) => c > -1.0 && c <= -0.5], ['-0.5..-0.1%', (c) => c > -0.5 && c <= -0.1],
  ['-0.1..+0.1%', (c) => c > -0.1 && c < 0.1], ['+0.1..+0.5%', (c) => c >= 0.1 && c < 0.5], ['+0.5..+1.0%', (c) => c >= 0.5 && c < 1.0], ['>= +1.0%', (c) => c >= 1.0],
]) printBucket(lbl, trades.filter((t) => fn(t.niftyDayChg)));

// ================= (B) NIFTY AT ENTRY vs prev close =================
console.log(`\n(B) by NIFTY vs prev close AT ENTRY HOUR  [actionable — no lookahead]`);
console.log(HEAD); console.log(RULE);
printBucket('Nifty GREEN at entry', trades.filter((t) => t.niftyAtEntry > 0));
printBucket('Nifty RED at entry', trades.filter((t) => t.niftyAtEntry < 0));

console.log(`\n(B2) by NIFTY-vs-prevclose-at-entry magnitude`);
console.log(HEAD); console.log(RULE);
for (const [lbl, fn] of [
  ['<= -1.0%', (c) => c <= -1.0], ['-1.0..-0.5%', (c) => c > -1.0 && c <= -0.5], ['-0.5..-0.2%', (c) => c > -0.5 && c <= -0.2],
  ['-0.2..+0.2%', (c) => c > -0.2 && c < 0.2], ['+0.2..+0.5%', (c) => c >= 0.2 && c < 0.5], ['+0.5..+1.0%', (c) => c >= 0.5 && c < 1.0], ['>= +1.0%', (c) => c >= 1.0],
]) printBucket(lbl, trades.filter((t) => t.niftyAtEntry != null && fn(t.niftyAtEntry)));

// ================= (G) OPENING GAP alone =================
console.log(`\n(G) by NIFTY OPENING GAP vs prev close  [known at 09:15]`);
console.log(HEAD); console.log(RULE);
for (const [lbl, fn] of [
  ['gap <= -1.0%', (c) => c <= -1.0], ['gap -1.0..-0.3%', (c) => c > -1.0 && c <= -0.3], ['gap -0.3..+0.3%', (c) => c > -0.3 && c < 0.3],
  ['gap +0.3..+1.0%', (c) => c >= 0.3 && c < 1.0], ['gap >= +1.0%', (c) => c >= 1.0],
]) printBucket(lbl, trades.filter((t) => fn(t.gapPct)));

// ================= (C) what-if: skip when Nifty RED at entry beyond X =================
console.log(`\n(C) what-if: skip trades when Nifty (vs prev close) at entry < -X%`);
console.log(`${'threshold'.padEnd(22)} | ${'kept'.padStart(5)} | ${'win%'.padStart(5)} | ${'stop%'.padStart(5)} | ${'totalPnl'.padStart(11)} | ${'₹/trd'.padStart(6)}  (cut: n / pnl)`);
console.log(RULE);
for (const x of [0, 0.3, 0.5, 0.75, 1.0, 1.5]) {
  const kept = trades.filter((t) => !(t.niftyAtEntry != null && t.niftyAtEntry < -x));
  const cut = trades.filter((t) => t.niftyAtEntry != null && t.niftyAtEntry < -x);
  const s = summarize(kept); const cs = summarize(cut);
  const lbl = x === 0 ? 'skip all Nifty-red' : `skip Nifty < -${x}%`;
  console.log(`${lbl.padEnd(22)} | ${String(s.n).padStart(5)} | ${s.winPct.toFixed(1).padStart(5)} | ${s.stopPct.toFixed(1).padStart(5)} | ${('₹' + Math.round(s.pnl).toLocaleString('en-IN')).padStart(11)} | ${String(Math.round(s.perTrade)).padStart(6)}  (cut ${cs.n} / ₹${Math.round(cs.pnl).toLocaleString('en-IN')})`);
}
const base = summarize(trades);
console.log(`\n(baseline total: n=${base.n}  pnl=₹${Math.round(base.pnl).toLocaleString('en-IN')}  win%=${base.winPct.toFixed(1)}  stop%=${base.stopPct.toFixed(1)})`);

// ================= (E) OOS split for the best down-filter =================
console.log(`\n(E) skip Nifty<-0.5% at entry, TRAIN(<2025-07)/TEST(>=2025-07)`);
console.log(HEAD); console.log(RULE);
const SPLIT = '2025-07';
for (const [seg, fn] of [
  ['TRAIN base', (t) => t.date < SPLIT],
  ['TRAIN filtered', (t) => t.date < SPLIT && !(t.niftyAtEntry < -0.5)],
  ['TEST base', (t) => t.date >= SPLIT],
  ['TEST filtered', (t) => t.date >= SPLIT && !(t.niftyAtEntry < -0.5)],
]) printBucket(seg, trades.filter(fn));
