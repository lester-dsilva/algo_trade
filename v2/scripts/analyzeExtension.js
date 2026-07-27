/**
 * Extension R&D: does buying when the ENTRY price is far above a daily moving average lose money?
 *
 * Unlike analyzeTrendTime (which measures D-1 close vs SMA), this measures the actual ENTRY
 * price (intraday, after the day's run-up) vs daily SMA10/20/50 built from bars strictly before
 * the trade date. Buckets win%/avg-R/total-R by extension, and reports the cost of a floor.
 *
 * Run from repo root:
 *   node v2/scripts/analyzeExtension.js [baselineName]   (default: fuck2)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = path.join(ROOT, 'v2', 'data');
const BASELINE_DIR = path.join(DATA, 'backtest_baselines');
const norm = (s) => s.toLowerCase().replace(/&/g, '').replace(/\s/g, '');

function buildDaily() {
  const folders = fs.readdirSync(DATA).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const bySym = new Map();
  for (const f of folders) {
    const file = path.join(DATA, f, 'prev_day_ohlc.csv');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim().split('\n');
    if (lines.length < 2) continue;
    const h = lines[0].toLowerCase().split(',').map((s) => s.trim());
    const ci = { s: h.indexOf('symbol'), d: h.indexOf('date'), c: h.indexOf('close') };
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(',');
      const s = p[ci.s]?.trim(); const d = p[ci.d]?.trim();
      if (!s || !d) continue;
      const n = norm(s);
      if (!bySym.has(n)) bySym.set(n, new Map());
      const m = bySym.get(n);
      if (!m.has(d)) m.set(d, { date: d, close: +p[ci.c] || 0 });
    }
  }
  const out = new Map();
  for (const [n, m] of bySym) out.set(n, [...m.values()].sort((a, b) => a.date.localeCompare(b.date)));
  return out;
}

function sma(arr, n) {
  if (arr.length < n) return null;
  const w = arr.slice(-n);
  return w.reduce((s, b) => s + b.close, 0) / w.length;
}

const name = process.argv[2] || 'fuck2';
const baseline = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, `${name}.json`), 'utf8'));
const trades = baseline.trades || [];
const daily = buildDaily();
console.log(`Baseline: ${name} | ${trades.length} trades\n`);

const rows = [];
for (const t of trades) {
  const ser = (daily.get(norm(t.symbol)) || []).filter((b) => b.date < t.date);
  if (ser.length < 20) continue;
  const sma20 = sma(ser, 20);
  const sma10 = sma(ser, 10);
  const sma50 = ser.length >= 50 ? sma(ser, 50) : null;
  const prevClose = ser[ser.length - 1].close;
  const risk = t.entry - t.stop;
  const r = risk > 0 ? (t.exitPrice - t.entry) / risk : null;
  if (r == null) continue;
  rows.push({
    symbol: t.symbol, date: t.date, time: (t.time || '').slice(0, 5), entry: t.entry, r, pnl: t.pnl,
    ext20: sma20 ? ((t.entry - sma20) / sma20) * 100 : null,   // ENTRY price vs SMA20
    ext10: sma10 ? ((t.entry - sma10) / sma10) * 100 : null,
    ext50: sma50 ? ((t.entry - sma50) / sma50) * 100 : null,
    prevExt20: sma20 ? ((prevClose - sma20) / sma20) * 100 : null, // D-1 close vs SMA20 (the old metric)
    sma20,
  });
}
console.log(`Trades with >=20d daily history: ${rows.length}\n`);

// IZMO spotlight
const izmo = rows.filter((x) => norm(x.symbol).includes('izmo'));
if (izmo.length) {
  console.log('=== IZMO trades ===');
  for (const x of izmo) {
    console.log(`  ${x.date} ${x.time}  entry=${x.entry.toFixed(1)}  SMA20=${x.sma20.toFixed(1)}  ext-vs-SMA20=${x.ext20.toFixed(1)}%  ext-vs-SMA10=${x.ext10?.toFixed(1)}%  R=${x.r.toFixed(2)}  pnl=${Math.round(x.pnl)}`);
  }
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
    console.log(`  [${loL},${hiL})`.padEnd(18) + `n=${String(g.length).padStart(4)}  win%=${String((100 * w / g.length).toFixed(0)).padStart(3)}  avgR=${avgR.toFixed(2)}  totalR=${totR.toFixed(0)}`);
  }
  console.log('');
}

bucket('ENTRY extension vs SMA20 (the idea)', 'ext20', [-1e9, 0, 5, 10, 15, 20, 30, 1e9]);
bucket('ENTRY extension vs SMA10', 'ext10', [-1e9, 0, 5, 10, 15, 20, 30, 1e9]);
bucket('ENTRY extension vs SMA50', 'ext50', [-1e9, 0, 10, 20, 35, 50, 1e9]);
bucket('D-1 CLOSE extension vs SMA20 (old metric, for contrast)', 'prevExt20', [-1e9, 0, 5, 10, 15, 20, 1e9]);

console.log('Cost of an ENTRY-vs-SMA20 extension ceiling (trades removed ABOVE each floor):');
for (const cap of [10, 12, 15, 18, 20, 25]) {
  const removed = rows.filter((x) => x.ext20 != null && x.ext20 >= cap);
  const kept = rows.filter((x) => x.ext20 != null && x.ext20 < cap);
  const remR = removed.reduce((s, x) => s + x.r, 0);
  const remPnl = removed.reduce((s, x) => s + x.pnl, 0);
  const keptR = kept.reduce((s, x) => s + x.r, 0);
  const remWin = removed.length ? (100 * removed.filter((x) => x.r > 0).length / removed.length).toFixed(0) : '-';
  console.log(`  cap ${cap}%:  remove ${String(removed.length).padStart(4)} trades (win%=${String(remWin).padStart(3)}, totalR=${remR.toFixed(0)}, pnl=₹${Math.round(remPnl).toLocaleString('en-IN')})  |  kept ${kept.length} trades totalR=${keptR.toFixed(0)}`);
}
