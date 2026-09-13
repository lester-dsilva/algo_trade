/**
 * Paths and watchlist helpers for v3 swing strategy.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const V3_DATA_DIR = path.join(ROOT, 'v3', 'data');
export const V3_DAILY_DIR = path.join(V3_DATA_DIR, 'daily');
export const V3_HOURLY_DIR = path.join(V3_DATA_DIR, 'hourly');
export const SCREEN_CACHE_PATH = path.join(V3_DATA_DIR, 'screen_cache.json');
export const V3_WATCHLIST_PATH = path.join(ROOT, 'config', 'v3_watchlist.txt');
export const V3_UNIVERSE_PATH = path.join(ROOT, 'config', 'nse_mcap_above_900cr.csv');
/** @deprecated use V3_WATCHLIST_PATH */
export const WATCHLIST_PATH = V3_WATCHLIST_PATH;
export const INSTRUMENTS_CACHE_PATH = path.join(ROOT, 'data', '.cache', 'instruments_nse.json');

export function normalizeFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

export function loadWatchlistSymbols(watchlistPath = process.env.V3_WATCHLIST_PATH || V3_WATCHLIST_PATH) {
  if (!fs.existsSync(watchlistPath)) return [];
  const raw = fs.readFileSync(watchlistPath, 'utf8').replace(/\r\n/g, '\n');
  const symbols = [];
  for (const line of raw.split('\n')) {
    const sym = line.replace(/#.*/, '').trim().split(',')[0].trim();
    if (!sym || sym.toUpperCase() === 'TRADINGSYMBOL') continue;
    symbols.push(sym.toUpperCase());
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

export function buildSymbolTokens(symbols, instruments) {
  const out = [];
  for (const sym of symbols) {
    const token = findToken(instruments, sym);
    if (token != null) out.push({ symbol: sym, token: Number(token) });
  }
  return out;
}

export function ensureV3Dirs() {
  for (const d of [V3_DATA_DIR, V3_DAILY_DIR, V3_HOURLY_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
