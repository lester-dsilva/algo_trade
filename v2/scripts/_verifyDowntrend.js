/** Verify the daily-downtrend SIZE-DOWN against the fuck_me config (full range). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBacktestForDate } from './runBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'backtest_baselines', 'fuck_me.json'), 'utf8')).config;
const dates = fs.readdirSync(DATA).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

function run(label, factor) {
  let n = 0, wins = 0, stops = 0, pnl = 0;
  for (const d of dates) {
    const out = runBacktestForDate(d, { quiet: true, ...cfg, downtrendSizeFactor: factor });
    if (!out) continue;
    n += out.trades;
    pnl += out.totalPnl;
    for (const r of out.results) { if (r.pnl > 0) wins++; if (r.exitReason === 'stop') stops++; }
  }
  const winPct = n ? (100 * wins / n).toFixed(1) : '0';
  const stopPct = n ? (100 * stops / n).toFixed(1) : '0';
  console.log(`${label.padEnd(34)} n=${String(n).padStart(4)}  win%=${winPct}  stop%=${stopPct}  NET ₹${Math.round(pnl).toLocaleString('en-IN')}  ₹/trd=${n ? Math.round(pnl / n) : 0}`);
}

console.log(`dates with data: ${dates.length} (${dates[0]} .. ${dates[dates.length - 1]})\n`);
run('size factor 1.0 (off / baseline)', 1);
run('size factor 0.5 (downsize, new dflt)', 0.5);
