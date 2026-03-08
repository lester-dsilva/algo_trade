/**
 * Compare backtest PnL: current (3% target, 1.5% trail) vs suggested (4% target, 1.2% trail).
 * Run from repo root: node v2/scripts/compareTargetTrail.js [YYYY-MM]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasBacktestData } from '../lib/loadBacktestData.js';
import { runBacktestForDate } from './runBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');

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

function runWithParams(dates, firstTargetPct, trailPct) {
  let totalPnl = 0;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  const byReason = { trail: 0, eod: 0, stop: 0 };
  for (const backtestDate of dates) {
    const out = runBacktestForDate(backtestDate, {
      quiet: true,
      firstTargetPct,
      trailPct,
    });
    if (!out) continue;
    totalPnl += out.totalPnl;
    totalTrades += out.trades;
    wins += out.wins;
    losses += out.losses;
    for (const r of out.results) {
      if (r.exitReason in byReason) byReason[r.exitReason]++;
    }
  }
  return { totalPnl, totalTrades, wins, losses, byReason };
}

function main() {
  const args = process.argv.slice(2);
  const monthArg = args.find((a) => /^\d{4}-\d{2}$/.test(a));

  const dates = getDatesWithData(monthArg || null);
  if (dates.length === 0) {
    console.error(monthArg ? `No data for ${monthArg}.` : 'No backtest data in v2/data.');
    process.exit(1);
  }

  console.error(`Comparing target/trail across ${dates.length} date(s)...\n`);

  const baseline = runWithParams(dates, 3, 1.5);
  const alternate = runWithParams(dates, 4, 1.2);

  console.log('--- Target / Trail comparison ---\n');
  console.log('                         | Current (3% / 1.5%) | Suggested (4% / 1.2%)');
  console.log('-------------------------|---------------------|----------------------');
  console.log(`Total PnL                | ${baseline.totalPnl.toFixed(2).padStart(17)} | ${alternate.totalPnl.toFixed(2).padStart(17)}`);
  console.log(`Total trades             | ${String(baseline.totalTrades).padStart(19)} | ${String(alternate.totalTrades).padStart(19)}`);
  console.log(`Wins                     | ${String(baseline.wins).padStart(19)} | ${String(alternate.wins).padStart(19)}`);
  console.log(`Losses                   | ${String(baseline.losses).padStart(19)} | ${String(alternate.losses).padStart(19)}`);
  console.log(`Exits: trail             | ${String(baseline.byReason.trail).padStart(19)} | ${String(alternate.byReason.trail).padStart(19)}`);
  console.log(`Exits: eod               | ${String(baseline.byReason.eod).padStart(19)} | ${String(alternate.byReason.eod).padStart(19)}`);
  console.log(`Exits: stop              | ${String(baseline.byReason.stop).padStart(19)} | ${String(alternate.byReason.stop).padStart(19)}`);
  console.log('');

  const diff = alternate.totalPnl - baseline.totalPnl;
  if (diff > 0) {
    console.log(`Suggested (4% / 1.2%) is better by ₹${diff.toFixed(2)}. Update runBacktest.js and lib/positionStore.js to use 4% and 1.2% if you want to adopt it.`);
  } else if (diff < 0) {
    console.log(`Current (3% / 1.5%) is better by ₹${Math.abs(diff).toFixed(2)}. Stick with current params.`);
  } else {
    console.log('Both param sets give the same total PnL.');
  }
  console.log('');
}

main();
