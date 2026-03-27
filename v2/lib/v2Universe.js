/**
 * Watchlist + path helpers for v2 backtest data (same universe as fetchBacktestData).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const V2_DATA_DIR = path.join(ROOT, 'v2', 'data');
export const WATCHLIST_PATH = path.join(ROOT, 'config', 'nse_mcap_above_900cr.csv');
export const INSTRUMENTS_CACHE_PATH = path.join(ROOT, 'data', '.cache', 'instruments_nse.json');

export function normalizeFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

export function loadWatchlistSymbols() {
  const raw = fs.readFileSync(WATCHLIST_PATH, 'utf8').replace(/\r\n/g, '\n').trim();
  const lines = raw.split('\n');
  if (lines.length < 2) return [];
  const symbols = [];
  for (let i = 1; i < lines.length; i++) {
    const sym = (lines[i].split(',')[0] || '').trim();
    if (sym) symbols.push(sym);
  }
  return symbols;
}

export function findToken(instruments, tradingsymbol) {
  const sym = tradingsymbol.includes(':') ? tradingsymbol.split(':')[1] : tradingsymbol;
  const nse = instruments.filter((i) => i.exchange === 'NSE');
  return (
    nse.find((i) => i.tradingsymbol === sym) ||
    nse.find((i) => i.tradingsymbol === sym + '-EQ') ||
    nse.find((i) => i.tradingsymbol === sym + '-BE')
  )?.instrument_token ?? null;
}

export function loadInstrumentsFromCache() {
  try {
    if (fs.existsSync(INSTRUMENTS_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(INSTRUMENTS_CACHE_PATH, 'utf8'));
    }
  } catch (_) {}
  return null;
}

/** Symbols from CSV that resolve to an NSE instrument token. */
export function buildSymbolTokens(symbols, instruments) {
  const out = [];
  for (const sym of symbols) {
    const token = findToken(instruments, sym);
    if (token != null) out.push({ symbol: sym, token: Number(token) });
  }
  return out;
}

export function listBacktestDateDirs() {
  if (!fs.existsSync(V2_DATA_DIR)) return [];
  return fs
    .readdirSync(V2_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
}

export function countPrevDayRows(backtestDate) {
  const file = path.join(V2_DATA_DIR, backtestDate, 'prev_day_ohlc.csv');
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim().split('\n');
  return Math.max(0, lines.length - 1);
}

/** @returns {string[]} trading symbols missing 3m CSV (expected = symbolTokens list). */
export function listMissing3mForDate(backtestDate, symbolTokens) {
  const threeMDir = path.join(V2_DATA_DIR, backtestDate, '3m');
  const have = new Set();
  if (fs.existsSync(threeMDir)) {
    for (const f of fs.readdirSync(threeMDir)) {
      if (f.endsWith('.csv')) have.add(f.slice(0, -4).toLowerCase());
    }
  }
  const missing = [];
  for (const { symbol } of symbolTokens) {
    if (!have.has(normalizeFilename(symbol))) missing.push(symbol);
  }
  return missing;
}
