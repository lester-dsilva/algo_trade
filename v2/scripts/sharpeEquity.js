/**
 * Compute Sharpe ratio and equity curve from backtest daily PnL.
 * Run from repo root: node v2/scripts/sharpeEquity.js [YYYY-MM]
 *
 * Outputs: Sharpe (annualized), max drawdown, equity curve (date, cumulative PnL).
 * Optionally writes v2/data/equity_curve.csv for charting.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasBacktestData } from '../lib/loadBacktestData.js';
import { runBacktestForDate } from './runBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');

const CAPITAL_PER_DAY = 50000; // scale for daily return (one position)
const TRADING_DAYS_PER_YEAR = 252;

function getDatesWithData(monthFilter) {
  if (!fs.existsSync(DATA_DIR)) return [];
  const dirs = fs.readdirSync(DATA_DIR);
  let dates = dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && hasBacktestData(d));
  if (monthFilter) {
    const [y, m] = monthFilter.split('-').map(Number);
    dates = dates.filter((d) => {
      const [dy, dm] = d.split('-').map(Number);
      return dy === y && dm === m;
    });
  }
  return dates.sort();
}

function main() {
  const args = process.argv.slice(2);
  const monthArg = args.find((a) => /^\d{4}-\d{2}$/.test(a));
  const writeCsv = args.includes('--csv');

  const dates = getDatesWithData(monthArg || null);
  if (dates.length === 0) {
    console.error(monthArg ? `No data for ${monthArg}.` : 'No backtest data in v2/data.');
    process.exit(1);
  }

  const rows = [];
  for (const backtestDate of dates) {
    const out = runBacktestForDate(backtestDate, { quiet: true });
    if (!out) continue;
    rows.push({ date: backtestDate, pnl: out.totalPnl });
  }

  if (rows.length === 0) {
    console.error('No backtest results.');
    process.exit(1);
  }

  // Daily return = PnL / capital (as decimal)
  const dailyReturns = rows.map((r) => r.pnl / CAPITAL_PER_DAY);
  const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (dailyReturns.length - 1) || 0;
  const stdReturn = Math.sqrt(variance);

  // Annualized Sharpe (risk-free = 0)
  const sharpe =
    stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(TRADING_DAYS_PER_YEAR) : null;

  // Equity curve
  let cum = 0;
  const equityCurve = rows.map((r) => {
    cum += r.pnl;
    return { date: r.date, dailyPnl: r.pnl, cumulativePnl: cum };
  });

  // Max drawdown (from running high of cumulative PnL)
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of equityCurve) {
    if (e.cumulativePnl > peak) peak = e.cumulativePnl;
    const dd = peak - e.cumulativePnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const totalPnl = equityCurve.length ? equityCurve[equityCurve.length - 1].cumulativePnl : 0;

  console.log('\n--- Sharpe & Equity ---\n');
  console.log(`Period: ${rows[0].date} to ${rows[rows.length - 1].date} (${rows.length} trading days)`);
  console.log(`Total PnL: ₹${totalPnl.toFixed(2)}`);
  console.log(`Mean daily return (on ₹${CAPITAL_PER_DAY.toLocaleString()}): ${(meanReturn * 100).toFixed(4)}%`);
  console.log(`Std daily return: ${(stdReturn * 100).toFixed(4)}%`);
  console.log(`Sharpe ratio (annualized, risk-free=0): ${sharpe != null ? sharpe.toFixed(3) : 'n/a'}`);
  console.log(`Max drawdown: ₹${maxDrawdown.toFixed(2)}`);
  if (maxDrawdown > 0 && totalPnl > 0) {
    const calmar = totalPnl / maxDrawdown;
    console.log(`Calmar ratio (total return / max DD): ${calmar.toFixed(2)}`);
  }

  console.log('\n--- Equity curve (first/last 5) ---');
  console.log('Date       | Daily PnL   | Cumulative PnL');
  console.log('-----------|-------------|----------------');
  const show = equityCurve.length <= 12 ? equityCurve : [...equityCurve.slice(0, 5), ...equityCurve.slice(-5)];
  const showDates = equityCurve.length <= 12 ? equityCurve : [...equityCurve.slice(0, 5), { date: '...', dailyPnl: 0, cumulativePnl: null }, ...equityCurve.slice(-5)];
  showDates.forEach((e) => {
    const cumStr = e.cumulativePnl != null ? e.cumulativePnl.toFixed(2).padStart(12) : '           —';
    console.log(`${e.date} | ${e.dailyPnl.toFixed(2).padStart(11)} | ${cumStr}`);
  });

  if (writeCsv) {
    const csvPath = path.join(DATA_DIR, 'equity_curve.csv');
    const lines = ['date,daily_pnl,cumulative_pnl', ...equityCurve.map((e) => `${e.date},${e.dailyPnl.toFixed(2)},${e.cumulativePnl.toFixed(2)}`)];
    fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
    console.log(`\nEquity curve written to ${csvPath}`);
  }
  console.log('');
}

main();
