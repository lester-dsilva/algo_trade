/**
 * Run v2 backtest for all dates with data; output PnL by month.
 * Run from repo root: node v2/scripts/backtestByMonth.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasBacktestData } from '../lib/loadBacktestData.js';
import { runBacktestForDate } from './runBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');

function getDatesWithData() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const dirs = fs.readdirSync(DATA_DIR);
  return dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && hasBacktestData(d)).sort();
}

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

const months = [...byMonth.keys()].sort();
let grandPnl = 0;
let grandTrades = 0;
console.log('Month    | Dates | Trades | PnL');
console.log('---------|-------|--------|----------');
for (const month of months) {
  const row = byMonth.get(month);
  grandPnl += row.pnl;
  grandTrades += row.trades;
  console.log(`${month} | ${String(row.dates).padStart(5)} | ${String(row.trades).padStart(6)} | ${row.pnl.toFixed(2).padStart(8)}`);
}
console.log('---------|-------|--------|----------');
console.log(`Total    |       | ${String(grandTrades).padStart(6)} | ${grandPnl.toFixed(2).padStart(8)}`);
console.log(`\nTotal PnL (all months): ${grandPnl.toFixed(2)}`);
