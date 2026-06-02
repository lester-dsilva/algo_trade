/**
 * Liquidity audit of baseline trades: compute avg 20-day turnover (₹ = close×volume) before each
 * trade and bucket win%/avg-R + count trades below liquidity floors. Run from repo root:
 *   node v2/scripts/analyzeLiquidity.js [baselineName]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = path.join(ROOT, 'v2', 'data');
const BASELINE_DIR = path.join(DATA, 'backtest_baselines');
const norm = (s) => s.toLowerCase().replace(/&/g, '').replace(/\s/g, '');

// daily series per symbol from prev_day_ohlc union
function buildDaily() {
  const folders = fs.readdirSync(DATA).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const bySym = new Map();
  for (const f of folders) {
    const file = path.join(DATA, f, 'prev_day_ohlc.csv');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim().split('\n');
    if (lines.length < 2) continue;
    const h = lines[0].toLowerCase().split(',').map((s) => s.trim());
    const ci = { s: h.indexOf('symbol'), d: h.indexOf('date'), c: h.indexOf('close'), v: h.indexOf('volume') };
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(',');
      const s = p[ci.s]?.trim(); const d = p[ci.d]?.trim();
      if (!s || !d) continue;
      const n = norm(s);
      if (!bySym.has(n)) bySym.set(n, new Map());
      const m = bySym.get(n);
      if (!m.has(d)) m.set(d, { date: d, close: +p[ci.c] || 0, vol: +p[ci.v] || 0 });
    }
  }
  const out = new Map();
  for (const [n, m] of bySym) out.set(n, [...m.values()].sort((a, b) => a.date.localeCompare(b.date)));
  return out;
}

const name = process.argv[2] || 'baseline';
const baseline = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, `${name}.json`), 'utf8'));
const trades = baseline.trades || [];
const daily = buildDaily();

const rows = [];
for (const t of trades) {
  const ser = (daily.get(norm(t.symbol)) || []).filter((b) => b.date < t.date);
  if (ser.length < 5) continue;
  const last20 = ser.slice(-20);
  const avgTurnover = last20.reduce((s, b) => s + b.close * b.vol, 0) / last20.length;
  const avgVol = last20.reduce((s, b) => s + b.vol, 0) / last20.length;
  const risk = t.entry - t.stop;
  const r = risk > 0 ? (t.exitPrice - t.entry) / risk : null;
  if (r == null) continue;
  rows.push({ symbol: t.symbol, date: t.date, avgTurnover, avgVol, r, pnl: t.pnl });
}

rows.sort((a, b) => a.avgTurnover - b.avgTurnover);
console.log(`Trades with daily data: ${rows.length}\n`);
console.log('20 LEAST liquid trades (avg 20d turnover):');
for (const x of rows.slice(0, 20)) {
  console.log(`  ${x.symbol.padEnd(12)} ${x.date}  turnover=₹${Math.round(x.avgTurnover / 1e5).toString().padStart(6)}L/day  vol=${Math.round(x.avgVol).toString().padStart(8)}/day  R=${x.r.toFixed(2)}`);
}

function bucket(label, edgesCr) {
  console.log(`\n${label} — win% / avg-R / total-R by avg-daily-turnover:`);
  for (let i = 0; i < edgesCr.length - 1; i++) {
    const lo = edgesCr[i] * 1e7, hi = edgesCr[i + 1] * 1e7; // crore → ₹
    const g = rows.filter((x) => x.avgTurnover >= lo && x.avgTurnover < hi);
    if (!g.length) continue;
    const w = g.filter((x) => x.r > 0).length;
    const avgR = g.reduce((s, x) => s + x.r, 0) / g.length;
    const totR = g.reduce((s, x) => s + x.r, 0);
    const loL = edgesCr[i] === 0 ? '0' : `${edgesCr[i]}cr`;
    const hiL = hi >= 1e12 ? '+' : `${edgesCr[i + 1]}cr`;
    console.log(`  [${loL}-${hiL})`.padEnd(16) + `n=${String(g.length).padStart(4)}  win%=${String((100 * w / g.length).toFixed(0)).padStart(3)}  avgR=${avgR.toFixed(2)}  totalR=${totR.toFixed(0)}`);
  }
}
bucket('Liquidity buckets', [0, 0.25, 0.5, 1, 2, 5, 10, 25, 1e6]);

console.log('\nTrades & total-R BELOW each turnover floor:');
for (const cr of [0.25, 0.5, 1, 2, 5]) {
  const below = rows.filter((x) => x.avgTurnover < cr * 1e7);
  const totR = below.reduce((s, x) => s + x.r, 0);
  const totPnl = below.reduce((s, x) => s + x.pnl, 0);
  console.log(`  < ₹${cr}cr/day:  ${String(below.length).padStart(4)} trades (${(100 * below.length / rows.length).toFixed(0)}%)  totalR=${totR.toFixed(0)}  totalPnl=₹${Math.round(totPnl).toLocaleString('en-IN')}`);
}
