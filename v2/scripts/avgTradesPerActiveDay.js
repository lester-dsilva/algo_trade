/**
 * Average number of trades on days when there was at least one trade.
 * Run from repo root: node v2/scripts/avgTradesPerActiveDay.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasBacktestData } from '../lib/loadBacktestData.js';
import { runBacktestForDate } from './runBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');

const dirs = fs.readdirSync(DATA_DIR);
const dates = dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && hasBacktestData(d)).sort();

let totalTrades = 0;
let daysWithTrades = 0;
for (const d of dates) {
  const out = runBacktestForDate(d, { quiet: true });
  if (!out) continue;
  totalTrades += out.trades;
  if (out.trades > 0) daysWithTrades += 1;
}

const avg = daysWithTrades > 0 ? totalTrades / daysWithTrades : 0;
console.log('Total trades:', totalTrades);
console.log('Days with at least 1 trade:', daysWithTrades);
console.log('Average trades on days when there were trades:', avg.toFixed(2));
