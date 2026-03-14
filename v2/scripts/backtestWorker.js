/**
 * Worker: run backtest for a chunk of dates. Used for parallel full backtest.
 * workerData: { dates: string[] }
 * Posts: { results: Array<{ date, totalPnl, trades, wins, losses, results }> }
 */

import { parentPort, workerData } from 'worker_threads';
import { runBacktestForDate } from './runBacktest.js';

const dates = workerData?.dates || [];
const results = [];

for (const date of dates) {
  try {
    const out = runBacktestForDate(date, { quiet: true });
    if (out)
      results.push({
        date: out.backtestDate,
        totalPnl: out.totalPnl,
        trades: out.trades,
        wins: out.wins,
        losses: out.losses,
        results: out.results,
      });
  } catch (err) {
    results.push({ date, error: err?.message || String(err) });
  }
}

parentPort.postMessage({ results });
