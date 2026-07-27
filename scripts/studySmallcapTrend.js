/**
 * Study: do baseline trades fail when the Smallcap-100 index is in a DAILY DOWNTREND?
 * Trend is measured from the index's own daily moving average, computed ONLY through the
 * prior trading day, so every signal is known at today's 09:15 open (no lookahead).
 *
 * For each trade date D we know (all from data ending the day BEFORE D):
 *   - prevClose          = Smallcap close on D-1
 *   - maN                = N-day SMA of daily closes ending D-1
 *   - distPct            = (prevClose - maN) / maN * 100      (how far above/below the MA)
 *   - slopePct           = (maN[D-1] - maN[D-6]) / maN[D-6] * 100   (5-day MA slope)
 *
 * Run: node scripts/studySmallcapTrend.js [baseline=fuck_me]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'v2', 'data');
const baseName = process.argv[2] || 'fuck_me';

const baseline = JSON.parse(fs.readFileSync(path.join(DATA, 'backtest_baselines', `${baseName}.json`), 'utf8'));
const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'smallcap100_hourly.json'), 'utf8'));

// ---- daily close series for the index (last bar of each day) ----
const byDay = {};
for (const r of idx.candles) (byDay[r.date] = byDay[r.date] || []).push(r);
const idxDates = Object.keys(byDay).sort();
const dailyClose = {}; // date -> close
for (const d of idxDates) {
  const bars = byDay[d].slice().sort((a, b) => a.time.localeCompare(b.time));
  dailyClose[d] = bars[bars.length - 1].close;
}

// ---- trend features per date, using data strictly BEFORE that date ----
// trendByDate[D] = { prevClose, ma10, ma20, ma50, dist10, dist20, dist50, slope20 }
const trendByDate = {};
const closeArr = idxDates.map((d) => dailyClose[d]);
const sma = (endIdx, n) => {
  if (endIdx + 1 < n) return null;
  let s = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) s += closeArr[i];
  return s / n;
};
for (let k = 1; k < idxDates.length; k++) {
  const D = idxDates[k];
  const prevIdx = k - 1; // index of D-1 in closeArr
  const prevClose = closeArr[prevIdx];
  const ma10 = sma(prevIdx, 10);
  const ma20 = sma(prevIdx, 20);
  const ma50 = sma(prevIdx, 50);
  const ma20_5ago = sma(prevIdx - 5, 20);
  trendByDate[D] = {
    prevClose,
    ma10, ma20, ma50,
    dist10: ma10 ? ((prevClose - ma10) / ma10) * 100 : null,
    dist20: ma20 ? ((prevClose - ma20) / ma20) * 100 : null,
    dist50: ma50 ? ((prevClose - ma50) / ma50) * 100 : null,
    slope20: ma20 && ma20_5ago ? ((ma20 - ma20_5ago) / ma20_5ago) * 100 : null,
  };
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
const HEAD = `${'bucket'.padEnd(24)} | ${'n'.padStart(5)} | ${'win%'.padStart(5)} | ${'stop%'.padStart(5)} | ${'totalPnl'.padStart(11)} | ${'₹/trd'.padStart(6)}`;
const RULE = '-'.repeat(HEAD.length);
function printBucket(label, trades) {
  const s = summarize(trades);
  console.log(`${label.padEnd(24)} | ${String(s.n).padStart(5)} | ${s.winPct.toFixed(1).padStart(5)} | ${s.stopPct.toFixed(1).padStart(5)} | ${('₹' + Math.round(s.pnl).toLocaleString('en-IN')).padStart(11)} | ${String(Math.round(s.perTrade)).padStart(6)}`);
}

// ---- attach trend context to each trade ----
const trades = [];
let missing = 0;
for (const t of baseline.trades) {
  const tr = trendByDate[t.date];
  if (!tr || tr.ma50 == null) { missing++; continue; }
  trades.push({ ...t, ...tr });
}
const base = summarize(trades);
console.log(`\nbaseline=${baseName}  trades=${baseline.trades.length}  matched(ma50 ready)=${trades.length}  missing/warmup=${missing}`);
console.log(`reference: index DAILY trend known at 09:15 (MA computed through prior day)`);
console.log(HEAD); console.log(RULE); printBucket('ALL', trades);

// ================= (A) above vs below each MA =================
for (const [n, key] of [[10, 'dist10'], [20, 'dist20'], [50, 'dist50']]) {
  console.log(`\n(A${n}) index prev-close vs its ${n}-day MA`);
  console.log(HEAD); console.log(RULE);
  printBucket(`ABOVE ${n}MA`, trades.filter((t) => t[key] >= 0));
  printBucket(`BELOW ${n}MA`, trades.filter((t) => t[key] < 0));
}

// ================= (B) distance-below buckets (20MA) =================
console.log(`\n(B) by distance of index vs 20-day MA`);
console.log(HEAD); console.log(RULE);
for (const [lbl, fn] of [
  ['<= -6%', (c) => c <= -6], ['-6..-3%', (c) => c > -6 && c <= -3], ['-3..-1%', (c) => c > -3 && c <= -1],
  ['-1..+1%', (c) => c > -1 && c < 1], ['+1..+3%', (c) => c >= 1 && c < 3], ['+3..+6%', (c) => c >= 3 && c < 6], ['>= +6%', (c) => c >= 6],
]) printBucket(lbl, trades.filter((t) => fn(t.dist20)));

// ================= (C) MA slope (20MA rising/falling) =================
console.log(`\n(C) by 20-day MA 5-day slope (momentum of the trend itself)`);
console.log(HEAD); console.log(RULE);
printBucket('MA rising (slope>0)', trades.filter((t) => t.slope20 > 0));
printBucket('MA flat (~0)', trades.filter((t) => t.slope20 != null && Math.abs(t.slope20) <= 0.1));
printBucket('MA falling (slope<0)', trades.filter((t) => t.slope20 < 0));

// ================= (D) combined: below 50MA AND falling 20MA =================
console.log(`\n(D) combined regimes`);
console.log(HEAD); console.log(RULE);
printBucket('UP (above50 & MA rising)', trades.filter((t) => t.dist50 >= 0 && t.slope20 > 0));
printBucket('DOWN (below50 & MA fall)', trades.filter((t) => t.dist50 < 0 && t.slope20 < 0));
printBucket('mixed', trades.filter((t) => !(t.dist50 >= 0 && t.slope20 > 0) && !(t.dist50 < 0 && t.slope20 < 0)));

// ================= (E) what-if skip rules, with OOS split =================
const SPLIT = '2025-07';
const rules = {
  'skip below 20MA': (t) => t.dist20 < 0,
  'skip below 50MA': (t) => t.dist50 < 0,
  'skip below50 & MAfall': (t) => t.dist50 < 0 && t.slope20 < 0,
  'skip dist20 < -3%': (t) => t.dist20 < -3,
  'skip MA falling': (t) => t.slope20 < 0,
};
console.log(`\n(E) what-if skip rules (kept = traded). cut = removed trades`);
console.log(`${'rule'.padEnd(24)} | ${'kept'.padStart(5)} | ${'win%'.padStart(5)} | ${'stop%'.padStart(5)} | ${'keptPnl'.padStart(11)} | ${'₹/trd'.padStart(6)}  (cut n / ₹)`);
console.log(RULE);
for (const [lbl, skipFn] of Object.entries(rules)) {
  const kept = trades.filter((t) => !skipFn(t));
  const cut = trades.filter(skipFn);
  const s = summarize(kept), cs = summarize(cut);
  console.log(`${lbl.padEnd(24)} | ${String(s.n).padStart(5)} | ${s.winPct.toFixed(1).padStart(5)} | ${s.stopPct.toFixed(1).padStart(5)} | ${('₹' + Math.round(s.pnl).toLocaleString('en-IN')).padStart(11)} | ${String(Math.round(s.perTrade)).padStart(6)}  (cut ${cs.n} / ₹${Math.round(cs.pnl).toLocaleString('en-IN')})`);
}
console.log(`\n(baseline total: n=${base.n}  pnl=₹${Math.round(base.pnl).toLocaleString('en-IN')}  win%=${base.winPct.toFixed(1)}  stop%=${base.stopPct.toFixed(1)}  ₹/trd=${Math.round(base.perTrade)})`);

// OOS for the most promising couple of rules
for (const lbl of ['skip below 50MA', 'skip below50 & MAfall']) {
  const skipFn = rules[lbl];
  console.log(`\n(F) OOS for "${lbl}"  TRAIN(<${SPLIT}) / TEST(>=${SPLIT})`);
  console.log(HEAD); console.log(RULE);
  printBucket('TRAIN base', trades.filter((t) => t.date < SPLIT));
  printBucket('TRAIN kept', trades.filter((t) => t.date < SPLIT && !skipFn(t)));
  printBucket('TEST base', trades.filter((t) => t.date >= SPLIT));
  printBucket('TEST kept', trades.filter((t) => t.date >= SPLIT && !skipFn(t)));
}

// ================= (G) the Jan-Mar 2025 crash window the user flagged =================
console.log(`\n(G) user-flagged window 2025-01-01 .. 2025-03-31 (smallcap crash)`);
console.log(HEAD); console.log(RULE);
const inWin = (t) => t.date >= '2025-01-01' && t.date <= '2025-03-31';
printBucket('crash window ALL', trades.filter(inWin));
printBucket('  of which below50MA', trades.filter((t) => inWin(t) && t.dist50 < 0));
printBucket('  of which above50MA', trades.filter((t) => inWin(t) && t.dist50 >= 0));
printBucket('rest of sample', trades.filter((t) => !inWin(t)));
