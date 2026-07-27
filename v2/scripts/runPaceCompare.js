/**
 * Compare the volume gate: current full-day multiple vs the time-of-day PACE gate at several K.
 * Full range, tiered sizing. Reports trades / win% / PnL / avg entry time, split train/test.
 *
 * Run from repo root:  node v2/scripts/runPaceCompare.js [startDate=2024-03-01]
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
console.error(`Dates: ${dates.length} (${dates[0]} .. ${dates[dates.length - 1]})`);

const toMin = (t) => { const [h, m] = (t || '').slice(0, 5).split(':').map(Number); return (h * 60 + m) - (9 * 60 + 15); };

function run(opts) {
  const seg = { train: blank(), test: blank() };
  for (const date of dates) {
    const out = runBacktestForDate(date, { quiet: true, tiers: TIERS, ...opts });
    if (!out) continue;
    acc(date < SPLIT ? seg.train : seg.test, out);
  }
  return seg;
}
function blank() { return { trades: 0, wins: 0, pnl: 0, charges: 0, tmin: 0 }; }
function acc(row, out) {
  row.trades += out.trades;
  row.wins += out.results.filter((r) => r.pnl > 0).length;
  row.pnl += out.totalPnl;
  row.charges += sumChargesForTrades(out.results);
  for (const r of out.results) row.tmin += toMin(r.time);
}
const fmt = (seg) => {
  const tot = { trades: seg.train.trades + seg.test.trades, wins: seg.train.wins + seg.test.wins, pnl: seg.train.pnl + seg.test.pnl, charges: seg.train.charges + seg.test.charges, tmin: seg.train.tmin + seg.test.tmin };
  const line = (lbl, r) => {
    const net = r.pnl - r.charges;
    return `  ${lbl.padEnd(6)} n=${String(r.trades).padStart(4)}  win%=${(r.trades ? 100 * r.wins / r.trades : 0).toFixed(1).padStart(5)}  gross=₹${String(Math.round(r.pnl).toLocaleString('en-IN')).padStart(9)}  charges=₹${String(Math.round(r.charges).toLocaleString('en-IN')).padStart(8)}  NET=₹${String(Math.round(net).toLocaleString('en-IN')).padStart(9)}  ₹/trade=${(r.trades ? net / r.trades : 0).toFixed(0).padStart(4)}`;
  };
  return [line('TRAIN', seg.train), line('TEST', seg.test), line('TOTAL', tot)].join('\n');
};

const variants = [
  ['FULLDAY 2.7x (current)', { volMode: 'fullday' }],
  ['PACE K=2.0', { volMode: 'pace', paceVolMult: 2.0 }],
  ['PACE K=2.7', { volMode: 'pace', paceVolMult: 2.7 }],
  ['PACE K=3.0', { volMode: 'pace', paceVolMult: 3.0 }],
  ['PACE K=3.5', { volMode: 'pace', paceVolMult: 3.5 }],
];
for (const [label, opts] of variants) {
  console.error(`running ${label}...`);
  const seg = run(opts);
  console.log(`\n=== ${label} ===`);
  console.log(fmt(seg));
}
