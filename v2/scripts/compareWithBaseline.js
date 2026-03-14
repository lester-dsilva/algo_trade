/**
 * Run backtest with current entry logic, load saved baseline, print per-month comparison.
 * Run from repo root: node v2/scripts/compareWithBaseline.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasBacktestData } from '../lib/loadBacktestData.js';
import { runBacktestForDate } from './runBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');
const BASELINE_PATH = path.join(DATA_DIR, 'backtest_baseline.json');

function getDatesWithData() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const dirs = fs.readdirSync(DATA_DIR);
  return dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && hasBacktestData(d)).sort();
}

const baseline = (() => {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    console.error('No baseline found at', BASELINE_PATH);
    console.error('Run: node v2/scripts/backtestByMonth.js --save-baseline (with baseline entry logic) first.');
    process.exit(1);
  }
})();

const dates = getDatesWithData();
if (dates.length === 0) {
  console.error('No backtest data in v2/data.');
  process.exit(1);
}

const byMonth = new Map();
for (const backtestDate of dates) {
  const out = runBacktestForDate(backtestDate, { quiet: true });
  if (!out) continue;
  const month = backtestDate.slice(0, 7);
  if (!byMonth.has(month)) byMonth.set(month, { trades: 0, wins: 0, losses: 0, pnl: 0, dates: 0 });
  const row = byMonth.get(month);
  row.trades += out.trades;
  row.wins += out.wins;
  row.losses += out.losses;
  row.pnl += out.totalPnl;
  row.dates += 1;
}

const baselineByMonth = new Map((baseline.byMonth || []).map((r) => [r.month, r]));
const months = [...new Set([...byMonth.keys(), ...baselineByMonth.keys()])].sort();

console.log('\n--- Backtest vs Baseline (by month) ---');
console.log('Baseline saved at:', baseline.savedAt || '?');
console.log('');
console.log('Month    | Base PnL    | Curr PnL   | PnL Diff    | Base Tr | Curr Tr | Tr Diff');
console.log('---------|-------------|------------|-------------|---------|---------|--------');
let totalBasePnl = 0;
let totalCurrPnl = 0;
let totalBaseTr = 0;
let totalCurrTr = 0;
for (const month of months) {
  const base = baselineByMonth.get(month) || { pnl: 0, trades: 0 };
  const curr = byMonth.get(month) || { pnl: 0, trades: 0 };
  const basePnl = base.pnl ?? 0;
  const currPnl = curr.pnl ?? 0;
  const baseTr = base.trades ?? 0;
  const currTr = curr.trades ?? 0;
  const pnlDiff = currPnl - basePnl;
  const trDiff = currTr - baseTr;
  totalBasePnl += basePnl;
  totalCurrPnl += currPnl;
  totalBaseTr += baseTr;
  totalCurrTr += currTr;
  const pnlDiffStr = (pnlDiff >= 0 ? '+' : '') + pnlDiff.toFixed(2);
  const trDiffStr = (trDiff >= 0 ? '+' : '') + trDiff;
  console.log(
    `${month} | ${basePnl.toFixed(2).padStart(11)} | ${currPnl.toFixed(2).padStart(10)} | ${pnlDiffStr.padStart(11)} | ${String(baseTr).padStart(7)} | ${String(currTr).padStart(7)} | ${trDiffStr.padStart(7)}`
  );
}
console.log('---------|-------------|------------|-------------|---------|---------|--------');
const totalPnlDiff = totalCurrPnl - totalBasePnl;
const totalTrDiff = totalCurrTr - totalBaseTr;
console.log(
  `Total    | ${totalBasePnl.toFixed(2).padStart(11)} | ${totalCurrPnl.toFixed(2).padStart(10)} | ${(totalPnlDiff >= 0 ? '+' : '') + totalPnlDiff.toFixed(2).padStart(11)} | ${String(totalBaseTr).padStart(7)} | ${String(totalCurrTr).padStart(7)} | ${(totalTrDiff >= 0 ? '+' : '') + totalTrDiff}`
);
console.log('');
