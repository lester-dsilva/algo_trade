/**
 * Run v2 backtest for all dates that have data (optionally filter by month). Print PnL per date and total.
 *
 * Run from repo root:
 *   node v2/scripts/runBacktestMonth.js
 *   node v2/scripts/runBacktestMonth.js 2026-02
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasBacktestData } from '../lib/loadBacktestData.js';
import { runBacktestForDate } from './runBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');
const BACKTEST_CACHE_DIR = path.join(DATA_DIR, 'backtest_cache');

function getDatesWithData(monthFilter) {
  if (!fs.existsSync(DATA_DIR)) return [];
  const dirs = fs.readdirSync(DATA_DIR);
  const dates = dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && hasBacktestData(d));
  if (monthFilter) {
    const [y, m] = monthFilter.split('-').map(Number);
    return dates.filter((d) => {
      const [dy, dm] = d.split('-').map(Number);
      return dy === y && dm === m;
    });
  }
  return dates.sort();
}

function writeBacktestCache(month, data) {
  if (!month) return;
  try {
    if (!fs.existsSync(BACKTEST_CACHE_DIR)) {
      fs.mkdirSync(BACKTEST_CACHE_DIR, { recursive: true });
    }
    const file = path.join(BACKTEST_CACHE_DIR, `${month}.json`);
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    console.error(`\nSaved month backtest JSON: ${file}`);
  } catch (err) {
    console.error('writeBacktestCache (CLI):', err.message);
  }
}

function main() {
  const args = process.argv.slice(2);
  const monthArg = args.find((a) => /^\d{4}-\d{2}$/.test(a));

  const dates = getDatesWithData(monthArg || null);
  if (dates.length === 0) {
    console.error(monthArg ? `No backtest data for month ${monthArg}.` : 'No backtest data in v2/data.');
    process.exit(1);
  }

  console.error(`Running backtest for ${dates.length} date(s)...\n`);

  const rows = [];
  for (const backtestDate of dates) {
    const out = runBacktestForDate(backtestDate, { quiet: true });
    if (!out) continue;
    rows.push({
      date: backtestDate,
      trades: out.trades,
      wins: out.wins,
      losses: out.losses,
      pnl: out.totalPnl,
      results: out.results,
    });
    console.error(`  ${backtestDate}  trades=${out.trades}  PnL=${out.totalPnl.toFixed(2)}`);
  }

  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);

  if (monthArg) {
    writeBacktestCache(monthArg, {
      month: monthArg,
      byDate: rows,
      totalPnl,
    });
  }

  console.log('\n--- v2 Backtest PnL (all dates) ---');
  console.log('Date       | Trades | Wins | Losses | PnL');
  console.log('-----------|--------|------|--------|----------');
  for (const r of rows) {
    console.log(`${r.date} | ${String(r.trades).padStart(6)} | ${String(r.wins).padStart(4)} | ${String(r.losses).padStart(6)} | ${r.pnl.toFixed(2).padStart(8)}`);
  }
  console.log('-----------|--------|------|--------|----------');
  console.log(`Total      | ${String(totalTrades).padStart(6)} |      |        | ${totalPnl.toFixed(2).padStart(8)}`);
  console.log(`\nTotal PnL: ${totalPnl.toFixed(2)}`);
}

main();
