/**
 * Extension R&D using INTRADAY 3m moving averages (not daily).
 * For each baseline trade, load the day's 3m bars, find the entry bar by time, and measure how far
 * the entry price is above several 3m moving averages:
 *   - 3m SMA20  (last 60 min)
 *   - 3m SMA10  (last 30 min)
 *   - 3m SMA of the whole day so far (anchored at 09:15 -> VWAP-ish mean)
 * Buckets win%/avg-R/total-R by extension and shows the cost of a ceiling. Spotlights IZMO.
 *
 * Run from repo root:
 *   node v2/scripts/analyzeExtension3m.js [baselineName]   (default: fuck2)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load3mForSymbol } from '../lib/loadBacktestData.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_DIR = path.join(ROOT, 'v2', 'data', 'backtest_baselines');
const norm = (s) => s.toLowerCase().replace(/&/g, '').replace(/\s/g, '');

const name = process.argv[2] || 'fuck2';
const baseline = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, `${name}.json`), 'utf8'));
const trades = baseline.trades || [];
console.log(`Baseline: ${name} | ${trades.length} trades (3m intraday MAs)\n`);

function smaCloses(bars, endIdx, n) {
  if (endIdx + 1 < n) return null;
  let s = 0;
  for (let k = endIdx - n + 1; k <= endIdx; k++) s += bars[k].close;
  return s / n;
}

const rows = [];
let noBar = 0;
for (const t of trades) {
  const bars = load3mForSymbol(t.date, t.symbol);
  if (!bars || !bars.length) { noBar++; continue; }
  const tt = (t.time || '').slice(0, 5);
  let ei = bars.findIndex((b) => (b.time || '').slice(0, 5) === tt);
  if (ei < 0) { noBar++; continue; }
  const risk = t.entry - t.stop;
  const r = risk > 0 ? (t.exitPrice - t.entry) / risk : null;
  if (r == null) continue;
  const sma20 = smaCloses(bars, ei, 20);
  const sma10 = smaCloses(bars, ei, 10);
  const dayMean = smaCloses(bars, ei, ei + 1); // all bars 0..ei
  const entry = t.entry;
  rows.push({
    symbol: t.symbol, date: t.date, time: tt, entry, r, pnl: t.pnl,
    ext20: sma20 ? ((entry - sma20) / sma20) * 100 : null,
    ext10: sma10 ? ((entry - sma10) / sma10) * 100 : null,
    extDay: dayMean ? ((entry - dayMean) / dayMean) * 100 : null,
    sma20, dayMean,
  });
}
console.log(`Trades matched to a 3m entry bar: ${rows.length}  (skipped ${noBar} no-bar/no-match)\n`);

const izmo = rows.filter((x) => norm(x.symbol).includes('izmo'));
if (izmo.length) {
  console.log('=== IZMO ===');
  for (const x of izmo)
    console.log(`  ${x.date} ${x.time}  entry=${x.entry.toFixed(1)}  3mSMA20=${x.sma20?.toFixed(1)} (ext ${x.ext20?.toFixed(1)}%)  dayMean=${x.dayMean?.toFixed(1)} (ext ${x.extDay?.toFixed(1)}%)  R=${x.r.toFixed(2)}`);
  console.log('');
}

function bucket(label, key, edges) {
  console.log(`${label}:`);
  const valid = rows.filter((x) => x[key] != null);
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const g = valid.filter((x) => x[key] >= lo && x[key] < hi);
    if (!g.length) continue;
    const w = g.filter((x) => x.r > 0).length;
    const avgR = g.reduce((s, x) => s + x.r, 0) / g.length;
    const totR = g.reduce((s, x) => s + x.r, 0);
    const loL = lo <= -1e8 ? '-inf' : `${lo}%`;
    const hiL = hi >= 1e8 ? '+inf' : `${hi}%`;
    console.log(`  [${loL},${hiL})`.padEnd(16) + `n=${String(g.length).padStart(4)}  win%=${String((100 * w / g.length).toFixed(0)).padStart(3)}  avgR=${avgR.toFixed(2)}  totalR=${totR.toFixed(0)}`);
  }
  console.log('');
}

bucket('ENTRY ext vs 3m SMA20 (last 60min)', 'ext20', [-1e9, 1, 2, 3, 4, 5, 7, 10, 1e9]);
bucket('ENTRY ext vs 3m SMA10 (last 30min)', 'ext10', [-1e9, 0.5, 1, 1.5, 2, 3, 5, 1e9]);
bucket('ENTRY ext vs 3m day-mean (since 09:15)', 'extDay', [-1e9, 2, 4, 6, 8, 12, 18, 1e9]);

console.log('Cost of a ceiling on ENTRY ext vs 3m SMA20 (remove trades AT/ABOVE cap):');
for (const cap of [4, 5, 6, 7, 8]) {
  const removed = rows.filter((x) => x.ext20 != null && x.ext20 >= cap);
  const remR = removed.reduce((s, x) => s + x.r, 0);
  const remPnl = removed.reduce((s, x) => s + x.pnl, 0);
  const remWin = removed.length ? (100 * removed.filter((x) => x.r > 0).length / removed.length).toFixed(0) : '-';
  console.log(`  cap ${cap}%:  remove ${String(removed.length).padStart(4)} (win%=${String(remWin).padStart(3)}, totalR=${remR.toFixed(0)}, pnl=₹${Math.round(remPnl).toLocaleString('en-IN')})`);
}
