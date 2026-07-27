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

// Module cache: market-wide intraday cumulative-volume profile (time HH:MM -> avg fraction of day done).
let _volProfile = null;
export function loadIntradayVolProfile() {
  if (_volProfile !== null) return _volProfile;
  const f = path.join(DATA_DIR, 'intraday_vol_profile.json');
  if (!fs.existsSync(f)) { _volProfile = null; return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    _volProfile = j.profile || null;
  } catch { _volProfile = null; }
  return _volProfile;
}

let _smallcapRegime = null;
/**
 * Load the intraday Smallcap-100 market-regime map for the gap-aware "skip when smallcap is red" gate.
 * Built from v2/data/smallcap100_3m.json (3-MINUTE index OHLC) so the intraday level is read at the
 * SAME granularity as the stock entry bar — the entry bar's index 3-min close. prevClose comes from the
 * OFFICIAL daily file (loadSmallcapDailyTrend) so the reference matches the live scanner's 'day' candle
 * close. Returns Map<date, { prevClose, bars: [{ tmin, close }] }> or null if the 3m file is missing.
 * Cached after first load. Dates not present resolve to undefined → the gate no-ops (trade allowed).
 */
export function loadSmallcapRegime() {
  if (_smallcapRegime !== null) return _smallcapRegime;
  const f = path.join(DATA_DIR, 'smallcap100_3m.json');
  if (!fs.existsSync(f)) { _smallcapRegime = null; return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const dailyTrend = loadSmallcapDailyTrend(); // official prev-close per date (matches live)
    const byDay = new Map();
    for (const r of j.candles || []) {
      if (!byDay.has(r.date)) byDay.set(r.date, []);
      byDay.get(r.date).push(r);
    }
    const toMin = (t) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
    const map = new Map();
    let prevCloseFallback = null; // 3m last bar of prior day, only if the daily file lacks the date
    for (const date of [...byDay.keys()].sort()) {
      const bars = byDay.get(date).slice().sort((a, b) => a.time.localeCompare(b.time));
      const officialPrev = dailyTrend?.get(date)?.prevClose;
      const prevClose = officialPrev != null ? officialPrev : prevCloseFallback;
      map.set(date, { prevClose, bars: bars.map((b) => ({ tmin: toMin(b.time), close: b.close })) });
      prevCloseFallback = bars[bars.length - 1].close;
    }
    _smallcapRegime = map;
  } catch { _smallcapRegime = null; }
  return _smallcapRegime;
}

let _smallcapDailyTrend = null;
/**
 * Load the Smallcap-100 DAILY-trend map for the daily-downtrend size-down.
 * Built from v2/data/smallcap100_daily.json — the index's OFFICIAL daily (15:30) closes, the SAME source
 * the live scanner uses (kite 'day' candles), so backtest and live build an identical MA. Using only
 * closes STRICTLY BEFORE date D (through D-1, known at D's 09:15):
 *   dist50  = (close[D-1] - SMA50[through D-1]) / SMA50 * 100   (how far above/below the 50-day MA)
 *   slope20 = (SMA20[through D-1] - SMA20[through D-6]) / SMA20[through D-6] * 100   (5-day MA slope)
 * Returns Map<date, { prevClose, dist50, slope20 }> or null if the file is missing. Cached after first
 * load. Dates without 50 prior closes (warmup) or not in the file resolve to undefined → gate no-ops.
 */
export function loadSmallcapDailyTrend() {
  if (_smallcapDailyTrend !== null) return _smallcapDailyTrend;
  const f = path.join(DATA_DIR, 'smallcap100_daily.json');
  if (!fs.existsSync(f)) { _smallcapDailyTrend = null; return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rows = (j.candles || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const dates = rows.map((r) => r.date);
    const closes = rows.map((r) => r.close);
    const sma = (endIdx, n) => {
      if (endIdx + 1 < n) return null;
      let s = 0;
      for (let i = endIdx - n + 1; i <= endIdx; i++) s += closes[i];
      return s / n;
    };
    const map = new Map();
    for (let k = 1; k < dates.length; k++) {
      const prev = k - 1; // index of D-1
      const prevClose = closes[prev];
      const ma50 = sma(prev, 50);
      const ma20 = sma(prev, 20);
      const ma20Prior = sma(prev - 5, 20);
      map.set(dates[k], {
        prevClose,
        dist50: ma50 ? ((prevClose - ma50) / ma50) * 100 : null,
        slope20: ma20 && ma20Prior ? ((ma20 - ma20Prior) / ma20Prior) * 100 : null,
      });
    }
    _smallcapDailyTrend = map;
  } catch { _smallcapDailyTrend = null; }
  return _smallcapDailyTrend;
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
