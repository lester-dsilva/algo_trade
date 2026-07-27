/**
 * Full-range tiered backtest from a start month, with the VWAP extension ceiling ON vs OFF.
 * Tiered position sizing: [75k,60k,50k,45k,40k,30k] by intraday sequence index.
 *
 * Run from repo root:
 *   node v2/scripts/runFullTiered.js [startDate=2024-03-01]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasBacktestData } from '../lib/loadBacktestData.js';
import { runBacktestForDate } from './runBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../..', 'v2', 'data');
const TIERS = [75000, 60000, 50000, 45000, 40000, 30000];
const startDate = process.argv[2] || '2024-03-01';
const SPLIT = '2025-07'; // train/test boundary (test = on/after)

const dates = fs.readdirSync(DATA_DIR)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= startDate && hasBacktestData(d))
  .sort();
console.error(`Dates: ${dates.length} (from ${dates[0]} to ${dates[dates.length - 1]})`);

function run(label, extraOpts) {
  const byMonth = new Map();
  const seg = { train: blank(), test: blank() };
  let allTrades = [];
  for (const date of dates) {
    const out = runBacktestForDate(date, { quiet: true, tiers: TIERS, ...extraOpts });
    if (!out) continue;
    const m = date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, blank());
    acc(byMonth.get(m), out);
    acc(date < SPLIT ? seg.train : seg.test, out);
    for (const r of out.results) allTrades.push({ date, ...r });
  }
  return { label, byMonth, seg, allTrades };
}
function blank() { return { trades: 0, wins: 0, pnl: 0 }; }
function acc(row, out) {
  row.trades += out.trades;
  row.wins += out.results.filter((r) => r.pnl > 0).length;
  row.pnl += out.totalPnl;
}
function winPct(r) { return r.trades ? (100 * r.wins / r.trades).toFixed(1) : '0.0'; }

const off = run('VWAP OFF', { maxVwapExtPct: 0 });
const on = run('VWAP ON (5%)', {}); // default 5%

console.log('\n=== Monthly PnL (tiered) ===');
console.log('Month    |  OFF trades   OFF pnl  |  ON trades    ON pnl');
console.log('---------|------------------------|----------------------');
const months = [...new Set([...off.byMonth.keys(), ...on.byMonth.keys()])].sort();
for (const m of months) {
  const o = off.byMonth.get(m) || blank();
  const n = on.byMonth.get(m) || blank();
  console.log(`${m} | ${String(o.trades).padStart(6)}  ${String(Math.round(o.pnl)).padStart(9)}  | ${String(n.trades).padStart(6)}  ${String(Math.round(n.pnl)).padStart(9)}`);
}

function summary(tag, r) {
  const t = r.seg.train, te = r.seg.test;
  const total = { trades: t.trades + te.trades, wins: t.wins + te.wins, pnl: t.pnl + te.pnl };
  console.log(`\n${tag}`);
  console.log(`  TRAIN (<${SPLIT}) : ${String(t.trades).padStart(4)} trades  win%=${winPct(t)}  pnl=₹${Math.round(t.pnl).toLocaleString('en-IN')}`);
  console.log(`  TEST  (>=${SPLIT}): ${String(te.trades).padStart(4)} trades  win%=${winPct(te)}  pnl=₹${Math.round(te.pnl).toLocaleString('en-IN')}`);
  console.log(`  TOTAL          : ${String(total.trades).padStart(4)} trades  win%=${winPct(total)}  pnl=₹${Math.round(total.pnl).toLocaleString('en-IN')}`);
  return total;
}
console.log('\n=== Summary ===');
const offT = summary('VWAP OFF (baseline):', off);
const onT = summary('VWAP ON (5% ceiling):', on);
console.log(`\nΔ TOTAL pnl: ₹${Math.round(onT.pnl - offT.pnl).toLocaleString('en-IN')}  |  Δ trades: ${onT.trades - offT.trades}  |  win% ${winPct(offT)} -> ${winPct(onT)}`);

// save the ON run as a baseline for the dashboard
const out = {
  savedAt: '(stamped post-run)',
  config: { tiers: TIERS, maxVwapExtPct: 5, note: 'time10:45 + trend deadzone + liquidity 2cr + VWAP 5% ceiling' },
  totalPnl: onT.pnl,
  totalTrades: onT.trades,
  trades: on.allTrades.map((r) => ({ date: r.date, symbol: r.symbol, time: r.time, entry: r.entry, stop: r.stop, exitReason: r.exitReason, exitPrice: r.exitPrice, pnl: r.pnl, qty: r.qty, seqIndex: r.seqIndex })),
};
const outPath = path.join(DATA_DIR, 'backtest_baselines', 'vwap_tiered.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log(`\nSaved ON run -> ${outPath} (${out.trades.length} trades)`);
