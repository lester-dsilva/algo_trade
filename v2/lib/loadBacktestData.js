/**
 * Load backtest data for a date from v2/data/YYYY-MM-DD/.
 * Use from v2 scripts; assumes run from repo root so ROOT is correct.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');

function normalizeFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

/**
 * Load previous-day OHLC for backtest date D.
 * Returns Map<symbol, { date, open, high, low, close, volume }> or null if file missing.
 */
export function loadPrevDayOhlc(backtestDate) {
  const file = path.join(DATA_DIR, backtestDate, 'prev_day_ohlc.csv');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  const lines = raw.split('\n');
  if (lines.length < 2) return new Map();
  const header = lines[0].toLowerCase().split(',').map((s) => s.trim());
  const idx = { symbol: header.indexOf('symbol'), date: header.indexOf('date'), open: header.indexOf('open'), high: header.indexOf('high'), low: header.indexOf('low'), close: header.indexOf('close'), volume: header.indexOf('volume') };
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const symbol = parts[idx.symbol]?.trim();
    if (!symbol) continue;
    map.set(symbol, {
      date: parts[idx.date]?.trim() ?? '',
      open: parseFloat(parts[idx.open]) || 0,
      high: parseFloat(parts[idx.high]) || 0,
      low: parseFloat(parts[idx.low]) || 0,
      close: parseFloat(parts[idx.close]) || 0,
      volume: parseFloat(parts[idx.volume]) || 0,
    });
  }
  return map;
}

/**
 * Load 3m bars for one symbol for backtest date D.
 * Returns array of { date, time, open, high, low, close, volume } or null if missing.
 */
export function load3mForSymbol(backtestDate, symbol) {
  const file = path.join(DATA_DIR, backtestDate, '3m', normalizeFilename(symbol) + '.csv');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  const lines = raw.split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(',').map((s) => s.trim());
  const get = (name) => header.indexOf(name);
  const idx = { date: get('date'), time: get('time'), open: get('open'), high: get('high'), low: get('low'), close: get('close'), volume: get('volume') };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    rows.push({
      date: p[idx.date] ?? '',
      time: p[idx.time] ?? '',
      open: parseFloat(p[idx.open]) || 0,
      high: parseFloat(p[idx.high]) || 0,
      low: parseFloat(p[idx.low]) || 0,
      close: parseFloat(p[idx.close]) || 0,
      volume: parseFloat(p[idx.volume]) || 0,
    });
  }
  return rows;
}

// Module cache: parsed prev_day_ohlc per folder (reused across dates in a backtest-all run).
const _prevDayFolderCache = new Map();
function loadPrevDayOhlcCached(folder) {
  if (_prevDayFolderCache.has(folder)) return _prevDayFolderCache.get(folder);
  const m = loadPrevDayOhlc(folder);
  _prevDayFolderCache.set(folder, m);
  return m;
}

/**
 * Reconstruct a recent daily OHLC series per symbol for trend context at a backtest date.
 * Unions prev_day_ohlc.csv from the most recent `lookback` date folders on or before
 * backtestDate (each file holds the full universe's daily bar for the day before that folder),
 * so every bar returned is strictly before backtestDate.
 * @returns Map<symbol, Array<{ date, open, high, low, close, volume }>> sorted ascending by date.
 */
export function loadRecentDailyForDate(backtestDate, lookback = 40) {
  if (!fs.existsSync(DATA_DIR)) return new Map();
  const folders = fs.readdirSync(DATA_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= backtestDate)
    .sort()
    .slice(-lookback);
  const bySym = new Map(); // symbol -> Map<date, bar>
  for (const folder of folders) {
    const m = loadPrevDayOhlcCached(folder);
    if (!m) continue;
    for (const [sym, bar] of m) {
      if (!bar.date) continue;
      if (!bySym.has(sym)) bySym.set(sym, new Map());
      const dm = bySym.get(sym);
      if (!dm.has(bar.date)) dm.set(bar.date, bar);
    }
  }
  const out = new Map();
  for (const [sym, dm] of bySym) {
    out.set(sym, [...dm.values()].sort((a, b) => a.date.localeCompare(b.date)));
  }
  return out;
}

/**
 * List symbols that have 3m data for the given backtest date.
 */
export function list3mSymbols(backtestDate) {
  const dir = path.join(DATA_DIR, backtestDate, '3m');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => f.replace(/\.csv$/i, ''));
}

/**
 * Check if backtest data exists for a date (prev_day_ohlc + at least one 3m file).
 */
export function hasBacktestData(backtestDate) {
  const prevFile = path.join(DATA_DIR, backtestDate, 'prev_day_ohlc.csv');
  const threeMDir = path.join(DATA_DIR, backtestDate, '3m');
  return fs.existsSync(prevFile) && fs.existsSync(threeMDir) && fs.readdirSync(threeMDir).some((f) => f.endsWith('.csv'));
}
