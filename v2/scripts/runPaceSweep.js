/**
 * Fine K sweep for the pace volume gate. For each K: trades, win%, stop-rate (chop),
 * net total (after charges), net/trade, and net in the recent test period.
 * Run: node v2/scripts/runPaceSweep.js [startDate=2024-03-01]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasBacktestData } from '../lib/loadBacktestData.js';
import { runBacktestForDate } from './runBacktest.js';
import { sumChargesForTrades } from '../../lib/zerodhaCharges.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../..', 'v2', 'data');
const TIERS = [75000, 60000, 50000, 45000, 40000, 30000];
const SPLIT = '2025-07';
const startDate = process.argv[2] || '2024-03-01';

const dates = fs.readdirSync(DATA_DIR)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= startDate && hasBacktestData(d))
  .sort();
console.error(`Dates: ${dates.length}`);

function run(opts) {
  let trades = 0, wins = 0, stops = 0, gross = 0, charges = 0;
  let tTrades = 0, tGross = 0, tCharges = 0; // test segment
  for (const date of dates) {
    const out = runBacktestForDate(date, { quiet: true, tiers: TIERS, ...opts });
    if (!out) continue;
    const c = sumChargesForTrades(out.results);
    trades += out.trades;
    wins += out.results.filter((r) => r.pnl > 0).length;
    stops += out.results.filter((r) => r.exitReason === 'stop').length;
    gross += out.totalPnl; charges += c;
    if (date >= SPLIT) { tTrades += out.trades; tGross += out.totalPnl; tCharges += c; }
  }
  const net = gross - charges, tNet = tGross - tCharges;
  return { trades, wins, stops, net, perTrade: trades ? net / trades : 0, winPct: trades ? 100 * wins / trades : 0, stopPct: trades ? 100 * stops / trades : 0, tNet, tTrades };
}

const variants = [
  ['FULLDAY 2.7', { volMode: 'fullday' }],
  ['PACE 1.5', { volMode: 'pace', paceVolMult: 1.5 }],
  ['PACE 1.75', { volMode: 'pace', paceVolMult: 1.75 }],
  ['PACE 2.0', { volMode: 'pace', paceVolMult: 2.0 }],
  ['PACE 2.25', { volMode: 'pace', paceVolMult: 2.25 }],
  ['PACE 2.5', { volMode: 'pace', paceVolMult: 2.5 }],
  ['PACE 2.75', { volMode: 'pace', paceVolMult: 2.75 }],
  ['PACE 3.0', { volMode: 'pace', paceVolMult: 3.0 }],
  ['PACE 3.5', { volMode: 'pace', paceVolMult: 3.5 }],
  ['PACE 4.0', { volMode: 'pace', paceVolMult: 4.0 }],
];

console.log('\nVariant      | trades | win% | stop%(chop) |    NET    | ₹/trade | NET(test)');
console.log('-------------|--------|------|-------------|----------|---------|----------');
const rows = [];
for (const [label, opts] of variants) {
  console.error(`running ${label}...`);
  const r = run(opts);
  rows.push([label, r]);
  console.log(
    `${label.padEnd(12)} | ${String(r.trades).padStart(6)} | ${r.winPct.toFixed(1).padStart(4)} | ${r.stopPct.toFixed(1).padStart(11)} | ${('₹' + Math.round(r.net).toLocaleString('en-IN')).padStart(8)} | ${String(Math.round(r.perTrade)).padStart(7)} | ${('₹' + Math.round(r.tNet).toLocaleString('en-IN')).padStart(8)}`
  );
}
// highlight best
const byNet = [...rows].sort((a, b) => b[1].net - a[1].net)[0];
const byTestNet = [...rows].sort((a, b) => b[1].tNet - a[1].tNet)[0];
const byChop = [...rows].sort((a, b) => a[1].stopPct - b[1].stopPct)[0];
console.log(`\nMax NET total : ${byNet[0]} (₹${Math.round(byNet[1].net).toLocaleString('en-IN')})`);
console.log(`Max NET test  : ${byTestNet[0]} (₹${Math.round(byTestNet[1].tNet).toLocaleString('en-IN')})`);
console.log(`Least chop    : ${byChop[0]} (stop% ${byChop[1].stopPct.toFixed(1)})`);
