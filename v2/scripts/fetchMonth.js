/**
 * Fetch backtest data for all trading days in a month using multiple processes.
 * Skips dates that already have data (prev_day_ohlc.csv + 3m/*.csv).
 *
 * Run from repo root:
 *   node v2/scripts/fetchMonth.js 2026-02
 *   node v2/scripts/fetchMonth.js 2026-02 --concurrency 4
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');

function getWeekdaysInMonth(year, month) {
  const dates = [];
  const lastDay = new Date(year, month, 0).getDate();
  for (let d = 1; d <= lastDay; d++) {
    const date = new Date(year, month - 1, d);
    const dow = date.getDay();
    if (dow >= 1 && dow <= 5) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(d).padStart(2, '0');
      dates.push(`${y}-${m}-${day}`);
    }
  }
  return dates;
}

function hasDataAlready(dateStr) {
  const prevFile = path.join(DATA_DIR, dateStr, 'prev_day_ohlc.csv');
  const threeMDir = path.join(DATA_DIR, dateStr, '3m');
  if (!fs.existsSync(prevFile)) return false;
  if (!fs.existsSync(threeMDir)) return false;
  try {
    const files = fs.readdirSync(threeMDir).filter((f) => f.endsWith('.csv'));
    return files.length > 0;
  } catch {
    return false;
  }
}

function runFetch(dateStr) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['v2/scripts/fetchBacktestData.js', dateStr], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    let stderr = '';
    let stdout = '';
    child.stderr?.on('data', (c) => { stderr += c.toString(); });
    child.stdout?.on('data', (c) => { stdout += c.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ dateStr, ok: true });
      else reject(new Error(`${dateStr} exit ${code}: ${stderr.slice(-500)}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const monthArg = args.find((a) => /^\d{4}-\d{2}$/.test(a));
  const concurrency = Math.min(8, Math.max(1, parseInt(args[args.indexOf('--concurrency') + 1], 10) || 4));
  if (!monthArg) {
    console.error('Usage: node v2/scripts/fetchMonth.js YYYY-MM [--concurrency N]');
    console.error('Example: node v2/scripts/fetchMonth.js 2026-02 --concurrency 4');
    process.exit(1);
  }
  const [year, month] = monthArg.split('-').map(Number);
  const allDays = getWeekdaysInMonth(year, month);
  const toFetch = allDays.filter((d) => !hasDataAlready(d));
  const skipped = allDays.length - toFetch.length;

  console.error(`Month: ${monthArg} | Weekdays: ${allDays.length} | Already have data: ${skipped} | To fetch: ${toFetch.length}`);
  if (toFetch.length === 0) {
    console.error('Nothing to fetch.');
    return;
  }
  console.error(`Running up to ${concurrency} processes at a time...\n`);

  let index = 0;
  const running = new Set();

  function runNext() {
    while (running.size < concurrency && index < toFetch.length) {
      const dateStr = toFetch[index++];
      const p = runFetch(dateStr)
        .then(() => {
          console.error(`[OK] ${dateStr}`);
          running.delete(p);
          runNext();
        })
        .catch((err) => {
          console.error(`[FAIL] ${dateStr}: ${err.message}`);
          running.delete(p);
          runNext();
        });
      running.add(p);
    }
    if (running.size === 0 && index >= toFetch.length) {
      console.error('\nDone.');
    }
  }

  runNext();
  await new Promise((r) => {
    const check = () => {
      if (running.size === 0 && index >= toFetch.length) r();
      else setTimeout(check, 500);
    };
    check();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
