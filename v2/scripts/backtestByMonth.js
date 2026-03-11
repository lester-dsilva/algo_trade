/**
 * Run v2 backtest for all dates with data; output PnL by month.
 * Optionally save trades + PnL as baseline (only when flag is passed).
 *
 * Run from repo root:
 *   node v2/scripts/backtestByMonth.js
 *   node v2/scripts/backtestByMonth.js --save-baseline
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

const args = process.argv.slice(2);
const saveBaseline = args.includes('--save-baseline') || args.includes('-b');

const dates = getDatesWithData();
if (dates.length === 0) {
  console.error('No backtest data in v2/data.');
  process.exit(1);
}

const byMonth = new Map();
const allTrades = [];

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
  if (saveBaseline && out.results && out.results.length) {
    for (const r of out.results) {
      allTrades.push({ date: backtestDate, symbol: r.symbol, time: r.time, entry: r.entry, stop: r.stop, exitReason: r.exitReason, exitPrice: r.exitPrice, pnl: r.pnl, qty: r.qty });
    }
  }
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

if (saveBaseline) {
  const byMonthArray = months.map((month) => {
    const row = byMonth.get(month);
    return { month, dates: row.dates, trades: row.trades, wins: row.wins, losses: row.losses, pnl: row.pnl };
  });
  const baseline = {
    savedAt: new Date().toISOString(),
    totalPnl: grandPnl,
    totalTrades: grandTrades,
    byMonth: byMonthArray,
    trades: allTrades,
  };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2), 'utf8');
  console.error(`\nBaseline saved to ${BASELINE_PATH} (${allTrades.length} trades).`);
}
