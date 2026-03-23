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
const HOLIDAYS_PATH = path.join(ROOT, 'config', 'nse_holidays.json');

function loadHolidaySet(year) {
  try {
    const raw = JSON.parse(fs.readFileSync(HOLIDAYS_PATH, 'utf8'));
    return new Set(raw[String(year)] || []);
  } catch {
    return new Set();
  }
}

function getTradingDaysInMonth(year, month) {
  const dates = [];
  const holidays = loadHolidaySet(year);
  const lastDay = new Date(year, month, 0).getDate();
  for (let d = 1; d <= lastDay; d++) {
    const date = new Date(year, month - 1, d);
    const dow = date.getDay();
    if (dow >= 1 && dow <= 5) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(d).padStart(2, '0');
      const dateStr = `${y}-${m}-${day}`;
      if (!holidays.has(dateStr)) dates.push(dateStr);
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
    // Use inherit so you see live batch progress (otherwise it looks "stuck" for many minutes).
    // With concurrency >1, two children' logs may interleave — use --concurrency 1 for clean output.
    console.error(`[START] ${dateStr}`);
    const child = spawn(process.execPath, [path.join(ROOT, 'v2', 'scripts', 'fetchBacktestData.js'), dateStr], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ dateStr, ok: true });
      else reject(new Error(`${dateStr} exit ${code}`));
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
  const allDays = getTradingDaysInMonth(year, month);
  const toFetch = allDays.filter((d) => !hasDataAlready(d));
  const skipped = allDays.length - toFetch.length;

  console.error(`Month: ${monthArg} | Trading days: ${allDays.length} | Already have data: ${skipped} | To fetch: ${toFetch.length}`);
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
