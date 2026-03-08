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
