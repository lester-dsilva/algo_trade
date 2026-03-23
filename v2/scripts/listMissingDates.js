/**
 * List trading days in a year that lack complete backtest data.
 * Usage: node v2/scripts/listMissingDates.js 2024
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

function tradingDaysInYear(year) {
  const holidays = loadHolidaySet(year);
  const dates = [];
  for (let m = 1; m <= 12; m++) {
    const last = new Date(year, m, 0).getDate();
    for (let d = 1; d <= last; d++) {
      const date = new Date(year, m - 1, d);
      const dow = date.getDay();
      if (dow < 1 || dow > 5) continue;
      const y = date.getFullYear();
      const mo = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(d).padStart(2, '0');
      const dateStr = `${y}-${mo}-${day}`;
      if (!holidays.has(dateStr)) dates.push(dateStr);
    }
  }
  return dates;
}

const year = parseInt(process.argv[2], 10) || new Date().getFullYear();
const all = tradingDaysInYear(year);
const missing = all.filter((d) => !hasDataAlready(d));
console.log(JSON.stringify({ year, totalTradingDays: all.length, have: all.length - missing.length, missingCount: missing.length, missing }, null, 2));
