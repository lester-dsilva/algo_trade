/**
 * Analyze trade performance by intraday sequence position (1st trade of day, 2nd, 3rd, 4th+).
 * Uses capital-independent metrics only: win%, avg %R per trade, exit type breakdown.
 *
 * Run from repo root:
 *   node v2/scripts/analyzeTradeSequence.js
 *   node v2/scripts/analyzeTradeSequence.js 2026-02
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

/** Bucket label for seqIndex */
function seqLabel(seqIndex) {
  const labels = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  return labels[seqIndex] ?? `${seqIndex + 1}th`;
}

function main() {
  const args = process.argv.slice(2);
  const monthArg = args.find((a) => /^\d{4}-\d{2}$/.test(a));

  const dates = getDatesWithData(monthArg || null);
  if (dates.length === 0) {
    console.error(monthArg ? `No backtest data for month ${monthArg}.` : 'No backtest data in v2/data.');
    process.exit(1);
  }

  console.error(`Analyzing ${dates.length} date(s)${monthArg ? ` for ${monthArg}` : ''}...\n`);

  // Buckets: seqIndex 0–5 (0 = 1st trade of day)
  const MAX_SEQ = 6;
  const buckets = Array.from({ length: MAX_SEQ }, () => ({
    trades: 0,
    wins: 0,
    losses: 0,
    sumReturnPct: 0,  // sum of (exitPrice - entry) / entry * 100
    stop: 0,
    trail: 0,
    eod: 0,
  }));

  let totalTrades = 0;

  for (const date of dates) {
    const out = runBacktestForDate(date, { quiet: true });
    if (!out) continue;

    for (const r of out.results) {
      if (r.exitReason === 'skip') continue;
      const idx = Math.min(r.seqIndex ?? 0, MAX_SEQ - 1);
      const b = buckets[idx];
      b.trades++;
      totalTrades++;
      if (r.pnl > 0) b.wins++; else b.losses++;
      b.sumReturnPct += ((r.exitPrice - r.entry) / r.entry) * 100;
      if (r.exitReason === 'stop')  b.stop++;
      if (r.exitReason === 'trail') b.trail++;
      if (r.exitReason === 'eod')   b.eod++;
    }
  }

  if (totalTrades === 0) {
    console.error('No trades found.');
    process.exit(0);
  }

  // ── print table ────────────────────────────────────────────────────────────
  const SEP = '------+--------+------+--------+-------+---------+-------+--------+------';
  const HDR = ' Seq  | Trades | Wins | Losses | Win%  | Avg %R  | stop% | trail% | eod% ';

  console.log('');
  console.log(monthArg ? `Trade sequence analysis — ${monthArg}` : 'Trade sequence analysis — all dates');
  console.log(`Dates: ${dates.length}  |  Total trades: ${totalTrades}`);
  console.log('');
  console.log(HDR);
  console.log(SEP);

  for (let i = 0; i < MAX_SEQ; i++) {
    const b = buckets[i];
    if (b.trades === 0) continue;

    const label   = seqLabel(i).padStart(4);
    const trades  = String(b.trades).padStart(6);
    const wins    = String(b.wins).padStart(4);
    const losses  = String(b.losses).padStart(6);
    const winPct  = ((b.wins / b.trades) * 100).toFixed(1).padStart(5);
    const avgR    = (b.sumReturnPct / b.trades).toFixed(3).padStart(7);
    const stopPct = ((b.stop  / b.trades) * 100).toFixed(1).padStart(5);
    const trailPct= ((b.trail / b.trades) * 100).toFixed(1).padStart(6);
    const eodPct  = ((b.eod   / b.trades) * 100).toFixed(1).padStart(4);

    console.log(` ${label} | ${trades} | ${wins} | ${losses} | ${winPct}% | ${avgR}% | ${stopPct}% | ${trailPct}% | ${eodPct}%`);
  }

  console.log(SEP);

  // ── overall row ────────────────────────────────────────────────────────────
  const allWins   = buckets.reduce((s, b) => s + b.wins, 0);
  const allLosses = buckets.reduce((s, b) => s + b.losses, 0);
  const allSumR   = buckets.reduce((s, b) => s + b.sumReturnPct, 0);
  const allStop   = buckets.reduce((s, b) => s + b.stop, 0);
  const allTrail  = buckets.reduce((s, b) => s + b.trail, 0);
  const allEod    = buckets.reduce((s, b) => s + b.eod, 0);

  const oWinPct   = ((allWins / totalTrades) * 100).toFixed(1).padStart(5);
  const oAvgR     = (allSumR / totalTrades).toFixed(3).padStart(7);
  const oStopPct  = ((allStop  / totalTrades) * 100).toFixed(1).padStart(5);
  const oTrailPct = ((allTrail / totalTrades) * 100).toFixed(1).padStart(6);
  const oEodPct   = ((allEod   / totalTrades) * 100).toFixed(1).padStart(4);

  console.log(` ${'ALL'.padStart(4)} | ${String(totalTrades).padStart(6)} | ${String(allWins).padStart(4)} | ${String(allLosses).padStart(6)} | ${oWinPct}% | ${oAvgR}% | ${oStopPct}% | ${oTrailPct}% | ${oEodPct}%`);
  console.log('');
  console.log('Avg %R = average (exitPrice - entry) / entry × 100  [capital-independent]');
  console.log('');
}

main();
