/**
 * Live scanner: subscribe to symbols from config/nse_mcap_above_900cr.csv,
 * build 3m candles from Kite ticks, run v2 entry logic on each new bar, persist paper positions, send Telegram alerts.
 *
 * v2 logic: 4% move in first 60 min (20×3m bars), pullback/consolidation, breakout (2.7× day vol, 1.1× breakout bar vs avg prev 5, gap ≤3%, wicks ≤35%).
 * Exits: fixed SL 1.5% below entry (same as v2 entryLogic backtest); 3% first target then 1.5% trail; square-off 15:20 IST (LTP); bar EOD 15:24; 15:30 sweep fallback. Position size ₹20,000 (max 6 concurrent).
 *
 * Usage: node scripts/liveScanner.js
 *
 * Requires: .env with Kite credentials; optional TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GAP_UP_THRESHOLD_PCT (extra gap skip).
 * Prev day volume: v2/data/YYYY-MM-DD or data/YYYY-MM-DD 3m CSVs (same as backtest). Max 3000 tokens per KiteTicker.
 *
 * Debug logs: LIVE_SCANNER_LOG=0 disables data/live_scanner.log; LOG_PATH overrides path.
 * Volume debug: each bar flush is logged to data/volume_debug.log (symbol, time, volume, volumeSource, firstCumVol, lastCumVol, sumQuantity). Set LIVE_SCANNER_LOG_VOLUME=0 to disable; LOG_VOLUME_PATH to override path. Heartbeat includes volume_debug: { cumulative_diff, sum_quantity } counts.
 */

import fs from 'fs';
import path from 'path';
import { getKite } from '../lib/kite.js';
import { KiteTicker } from 'kiteconnect';
import { createCandleBuilder } from '../lib/candleBuilder.js';
import { findEntry, computeTrendFeatures, isTrendDeadZone, FIRST_HOUR_BAR_COUNT, GAP_UP_MAX_PCT } from '../v2/lib/entryLogic.js';
import { addPosition, processBar, getTotalPnl, eodSweep, getOpenPositions, POSITION_VALUE, closeAllOpenAtPrices } from '../lib/positionStore.js';
import { sendAlert, isConfigured as telegramConfigured } from '../lib/telegram.js';
import { placeBuyOrder, placeSellOrder } from '../lib/orderExecutor.js';

const WATCHLIST_PATH = path.join(process.cwd(), 'config', 'nse_mcap_above_900cr.csv');
const MAX_TOKENS = 3000;

const LIVE_TRADING        = process.env.LIVE_TRADING === 'true';
const MAX_POSITIONS       = parseInt(process.env.MAX_POSITIONS || '6', 10);
const LIVE_TIERED_SIZING  = process.env.LIVE_TIERED_SIZING === 'true';
/** Stop distance below entry for live entries only (findEntry gets fixedSlPct override). */
const LIVE_FIXED_SL_PCT   = 1.5;

// Findings-based filters (match v2 entryLogic defaults; override via env).
// V2_MIN_ENTRY_TIME='' disables the early-entry filter; V2_TREND_FILTER='false' disables the dead-zone filter.
const V2_MIN_ENTRY_TIME = process.env.V2_MIN_ENTRY_TIME != null ? process.env.V2_MIN_ENTRY_TIME : '10:45';
const V2_TREND_FILTER   = process.env.V2_TREND_FILTER !== 'false';
// Liquidity floor: min avg 20d turnover (₹). Default ₹2cr/day; V2_MIN_TURNOVER=0 disables.
const V2_MIN_TURNOVER   = process.env.V2_MIN_TURNOVER != null ? parseFloat(process.env.V2_MIN_TURNOVER) : 2e7;

// Smallcap-100 daily-downtrend SIZE-DOWN (mirrors v2 runBacktest): on days where the index closed below
// its 50-day MA AND its 20-day MA is falling (both known at 09:15), size every trade down to this factor
// of normal. The down-regime trades stay positive-EV so we keep taking them, just smaller. 1 disables.
const SMALLCAP_TOKEN              = parseInt(process.env.SMALLCAP_TOKEN || '267017', 10);
const LIVE_DOWNTREND_SIZE_FACTOR  = process.env.LIVE_DOWNTREND_SIZE_FACTOR != null ? parseFloat(process.env.LIVE_DOWNTREND_SIZE_FACTOR) : 0.5;

// Smallcap-100 intraday market-regime gate (mirrors v2 entryLogic maxMarketDownPct): skip new entries
// while the index is down more than this % vs YESTERDAY's index close, measured from the live index
// level at the entry bar. 0 disables. No-op until the index ticks / prev close are available.
const LIVE_MAX_MARKET_DOWN_PCT    = process.env.LIVE_MAX_MARKET_DOWN_PCT != null ? parseFloat(process.env.LIVE_MAX_MARKET_DOWN_PCT) : 1.0;

// Tier % allocation per trade sequence (must sum to 100; default: front-weighted 25/20/17/15/13/10)
const LIVE_TIER_PCTS = process.env.LIVE_TIER_PCTS
  ? process.env.LIVE_TIER_PCTS.split(',').map((v) => parseFloat(v.trim())).filter((v) => Number.isFinite(v) && v > 0)
  : [34.4, 26.6, 17.2, 9.4, 6.2, 6.2]; // front-loaded: most days are 1-2 trades, slots 4-6 rarely fire

// Capital to distribute. If set, tier amounts are auto-calculated: LIVE_CAPITAL × pct%.
// Falls back to explicit LIVE_TIERS if LIVE_CAPITAL is not set.
const LIVE_CAPITAL = parseInt(process.env.LIVE_CAPITAL || '0', 10);
const LIVE_TIERS = (() => {
  if (LIVE_CAPITAL > 0) {
    return LIVE_TIER_PCTS.map((pct) => Math.max(1000, Math.floor(LIVE_CAPITAL * pct / 100)));
  }
  if (process.env.LIVE_TIERS) {
    return process.env.LIVE_TIERS.split(',').map((v) => Math.max(1000, parseInt(v.trim(), 10))).filter((v) => Number.isFinite(v) && v > 0);
  }
  return [110000, 85000, 55000, 30000, 20000, 20000]; // last-resort default (front-loaded; ₹320k full)
})();

/** File log for debugging when away during market hours. Logs to data/live_scanner.log by default. Set LIVE_SCANNER_LOG=0 to disable, or LOG_PATH for custom path. */
const LOG_ENABLED = process.env.LIVE_SCANNER_LOG !== '0' && process.env.LIVE_SCANNER_LOG !== 'false';
const LOG_PATH = process.env.LOG_PATH
  ? path.resolve(process.cwd(), process.env.LOG_PATH)
  : path.join(process.cwd(), 'data', 'live_scanner.log');

/** Volume debug log: one line per bar flush (symbol, time, volume, cumulative_diff vs sum_quantity). Set LIVE_SCANNER_LOG_VOLUME=0 to disable. */
const LOG_VOLUME_ENABLED = process.env.LIVE_SCANNER_LOG_VOLUME !== '0' && process.env.LIVE_SCANNER_LOG_VOLUME !== 'false';
const LOG_VOLUME_PATH = process.env.LOG_VOLUME_PATH
  ? path.resolve(process.cwd(), process.env.LOG_VOLUME_PATH)
  : path.join(process.cwd(), 'data', 'volume_debug.log');

function logToFile(event, detail = '') {
  if (!LOG_ENABLED) return;
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const line = `${ts}\t${event}\t${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`;
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (_) {}
}

function logVolumeFlush(info) {
  if (!LOG_VOLUME_ENABLED) return;
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const line = `${ts}\tbar_volume\t${JSON.stringify(info)}\n`;
  try {
    const dir = path.dirname(LOG_VOLUME_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_VOLUME_PATH, line, 'utf8');
  } catch (_) {}
}

/** Return date string N calendar days before dateStr (YYYY-MM-DD). */
function dateMinusDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Return YYYY-MM-DD in IST from a Kite day-candle (API timestamps are exchange/IST). */
function candleDateStr(c) {
  if (!c || c.date == null) return '';
  const d = c.date instanceof Date ? c.date : new Date(c.date);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Return HH:MM:SS in IST from a Kite candle timestamp. */
function candleTimeStr(c) {
  if (!c || c.date == null) return '';
  const d = c.date instanceof Date ? c.date : new Date(c.date);
  return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
}

/** Build normalized 3m bars from Kite historical candles for one date. */
function buildHistoricalBars(candles, dateStr) {
  const rows = [];
  for (const c of candles || []) {
    if (candleDateStr(c) !== dateStr) continue;
    rows.push({
      date: dateStr,
      time: candleTimeStr(c),
      open: Number.isFinite(c.open) ? c.open : 0,
      high: Number.isFinite(c.high) ? c.high : 0,
      low: Number.isFinite(c.low) ? c.low : 0,
      close: Number.isFinite(c.close) ? c.close : 0,
      volume: Number.isFinite(c.volume) ? c.volume : 0,
    });
  }
  rows.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  return rows;
}

/** Detect whether the current just-closed bar qualifies on price structure alone (ignoring volume filters).
 *  When officialDayOpen is provided (from 9:20 API), use it — live bars can miss 09:15 so bars[0].open may be wrong.
 */
function findEntryIgnoringVolumeForCurrentBar(bars, prevClose, officialDayOpen = null, trend = null, minEntryTime = V2_MIN_ENTRY_TIME, trendFilter = V2_TREND_FILTER, minAvgTurnover = V2_MIN_TURNOVER) {
  if (!prevClose || prevClose <= 0) return null;

  // findings: skip mild-downtrend "drifter" dead-zone (safe no-op if trend absent)
  if (trendFilter && isTrendDeadZone(trend)) return null;

  // liquidity floor: skip illiquid names (avg 20d turnover below floor; safe no-op if trend absent)
  if (minAvgTurnover > 0 && trend && trend.avgTurnover20 != null && trend.avgTurnover20 < minAvgTurnover) return null;

  const MOVE_UP_MIN_PCT = 4;
  const PULLBACK_PCT = 1;
  const PULLBACK_MAX_FROM_TOP_PCT = 4;
  const WICK_MAX_PCT = 0.35;
  const VOL_AVG_LOOKBACK = 5;
  const CONSOLIDATION_RANGE_PCT = 2;
  const MAX_ENTRY_TIME = '12:30';
  const MAX_DAY_MOVE_PCT = 14;
  const BREAKOUT_STRENGTH_MIN_PCT = 0.4;

  if (!bars || bars.length < FIRST_HOUR_BAR_COUNT + VOL_AVG_LOOKBACK + 1) return null;

  const i = bars.length - 1;
  const bar = bars[i];
  const dayOpen = (officialDayOpen != null && officialDayOpen > 0) ? officialDayOpen : bars[0].open;
  const gapPct = prevClose > 0 ? ((dayOpen - prevClose) / prevClose) * 100 : 0;
  if (gapPct > GAP_UP_MAX_PCT) return null;

  const firstHourBars = bars.slice(0, FIRST_HOUR_BAR_COUNT);
  const firstHourHigh = Math.max(...firstHourBars.map((b) => b.high));
  const movePct = dayOpen > 0 ? ((firstHourHigh - dayOpen) / dayOpen) * 100 : 0;
  if (movePct < MOVE_UP_MIN_PCT) return null;

  const barTime = (bar.time || '').slice(0, 5);
  if (minEntryTime && barTime < minEntryTime) return null;
  if (barTime > MAX_ENTRY_TIME) return null;

  const dayMovePct = dayOpen > 0 ? ((bar.close - dayOpen) / dayOpen) * 100 : 0;
  if (dayMovePct > MAX_DAY_MOVE_PCT) return null;

  const dayHighSoFar = Math.max(...bars.slice(0, i + 1).map((b) => b.high));
  let highBarIdx = i;
  for (let k = 0; k <= i; k++) {
    if (bars[k].high >= dayHighSoFar) {
      highBarIdx = k;
      break;
    }
  }

  let pullbackLow = dayHighSoFar;
  if (highBarIdx < i - 1) {
    for (let j = highBarIdx + 1; j < i; j++) {
      if (bars[j].low < pullbackLow) pullbackLow = bars[j].low;
    }
    const pullbackPct = dayHighSoFar > 0 ? ((dayHighSoFar - pullbackLow) / dayHighSoFar) * 100 : 0;
    if (pullbackPct > PULLBACK_MAX_FROM_TOP_PCT) return null;
  }

  let hasPullback = false;
  for (let j = FIRST_HOUR_BAR_COUNT; j < i; j++) {
    if (bars[j].low <= firstHourHigh * (1 - PULLBACK_PCT / 100)) {
      hasPullback = true;
      break;
    }
  }

  const recent5 = bars.slice(i - VOL_AVG_LOOKBACK, i);
  const recentHigh = Math.max(...recent5.map((b) => b.high));
  const recentLow = Math.min(...recent5.map((b) => b.low));
  const rangePct = recent5[0]?.open > 0 ? ((recentHigh - recentLow) / recent5[0].open) * 100 : 100;
  const hasConsolidation = rangePct <= CONSOLIDATION_RANGE_PCT;
  if (!hasPullback && !hasConsolidation) return null;

  const breakoutAbovePct = recentHigh > 0 ? ((bar.close - recentHigh) / recentHigh) * 100 : 0;
  if (breakoutAbovePct < BREAKOUT_STRENGTH_MIN_PCT) return null;
  if (bar.close <= bar.open) return null;

  const dayHighBeforeBar = i > 0 ? Math.max(...bars.slice(0, i).map((b) => b.high)) : bar.high;
  if (bar.close <= dayHighBeforeBar) return null;

  const range = bar.high - bar.low;
  if (range <= 0) return null;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBottom = Math.min(bar.open, bar.close);
  const upperWick = bar.high - bodyTop;
  const lowerWick = bodyBottom - bar.low;
  if (upperWick / range > WICK_MAX_PCT || lowerWick / range > WICK_MAX_PCT) return null;

  const entry = bar.close;
  const stop = Math.round(entry * (1 - LIVE_FIXED_SL_PCT / 100) * 100) / 100;
  return { entry, stop, time: bar.time, barIndex: i, date: bar.date };
}

/** Ms until 9:20 AM IST (defer today open fetch so day candle is stable). Returns 0 if already past. */
function msUntil920Ist() {
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const target = new Date(`${todayIST}T09:20:00+05:30`);
  const ms = target.getTime() - Date.now();
  return ms > 0 ? ms : 0;
}

/** Run async fn; on failure retry up to maxRetries times with exponential backoff (baseDelayMs * 2^attempt). */
async function withExponentialBackoff(fn, maxRetries = 4, baseDelayMs = 1000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function loadWatchlistSymbols() {
  const raw = fs.readFileSync(WATCHLIST_PATH, 'utf8').replace(/\r\n/g, '\n').trim();
  const lines = raw.split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  const symCol = header.includes('tradingsymbol') ? 0 : 0;
  const symbols = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    const sym = (row[symCol] || '').trim();
    if (sym) symbols.push(sym);
  }
  return symbols;
}

function findInstrumentToken(instruments, tradingsymbol) {
  const sym = (tradingsymbol.includes(':') ? tradingsymbol.split(':')[1] : tradingsymbol).trim();
  if (!sym) return null;
  const nse = instruments.filter((i) => i.exchange === 'NSE');
  const trySym = (s) => nse.find((i) => i.tradingsymbol === s || i.tradingsymbol.toUpperCase() === s.toUpperCase());
  const row = trySym(sym) || trySym(`${sym}-EQ`) || trySym(`${sym}-BE`);
  return row ? row.instrument_token : null;
}

/** Normalize symbol to lowercase CSV filename (matches v2 / analyzePnl). */
function normalizeSymbolFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

/** Find the most recent date folder before todayStr. Prefers v2/data, then data/. Returns { folder, baseDir } or null. */
function findPrevDateFolder(todayStr) {
  const cwd = process.cwd();
  for (const baseDir of [path.join(cwd, 'v2', 'data'), path.join(cwd, 'data')]) {
    try {
      if (!fs.existsSync(baseDir)) continue;
      const dirs = fs.readdirSync(baseDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < todayStr)
        .sort()
        .reverse();
      if (dirs.length > 0) return { folder: dirs[0], baseDir };
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Load ALL 3m candles for symbol. Tries v2/data/<date>/3m/<symbol>.csv then data/<date>/<symbol>.csv.
 * prevInfo = { folder, baseDir } from findPrevDateFolder.
 */
function loadPrevDayAllBars(symbol, prevInfo) {
  if (!prevInfo) return [];
  const file = normalizeSymbolFilename(symbol) + '.csv';
  const isV2 = prevInfo.baseDir.includes('v2');
  const csvPath = isV2
    ? path.join(prevInfo.baseDir, prevInfo.folder, '3m', file)
    : path.join(prevInfo.baseDir, prevInfo.folder, file);
  try {
    if (!fs.existsSync(csvPath)) return [];
    const lines = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const header = lines[0].toLowerCase().split(',').map(s => s.trim());
    const rows = [];
    for (let li = 1; li < lines.length; li++) {
      const vals = lines[li].split(',');
      const r = {};
      header.forEach((h, j) => { r[h] = (vals[j] ?? '').trim(); });
      const o = parseFloat(r.open), h2 = parseFloat(r.high), l = parseFloat(r.low), c = parseFloat(r.close), v = parseFloat(r.volume);
      if (!r.date || !Number.isFinite(o) || o === 0) continue;
      rows.push({ date: r.date, time: r.time, open: o, high: h2, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
    }
    return rows;
  } catch { return []; }
}

/** Last nBars of prev day 3m (for any legacy use). */
function loadPrevDayTailBars(symbol, prevInfo, nBars = 25) {
  const all = loadPrevDayAllBars(symbol, prevInfo);
  return all.slice(-nBars);
}

/**
 * Compute today's Smallcap-100 daily-downtrend size factor from the index's own daily closes (token
 * SMALLCAP_TOKEN), using only closes STRICTLY BEFORE today (through yesterday) so it's known at 09:15.
 * Mirrors v2/lib/loadBacktestData.js#loadSmallcapDailyTrend so live and backtest can't drift:
 *   dist50  = (close[-1] - SMA50) / SMA50 * 100        (below the 50-day MA?)
 *   slope20 = (SMA20[-1] - SMA20[-6]) / SMA20[-6] * 100 (is the 20-day MA falling?)
 *   downtrend = dist50 < 0 AND slope20 < 0  → factor = downFactor, else 1.
 * Returns { factor, isDown, dist50, slope20, prevClose, bars }. factor=1 on insufficient history/errors.
 */
async function computeSmallcapDowntrend(kite, todayStr, token, downFactor) {
  const from = new Date(`${dateMinusDays(todayStr, 110)}T00:00:00+05:30`);
  const to = new Date(`${todayStr}T23:59:59+05:30`);
  const candles = await kite.getHistoricalData(token, 'day', from, to, false, false);
  const closes = (candles || [])
    .filter((c) => candleDateStr(c) < todayStr)
    .sort((a, b) => candleDateStr(a).localeCompare(candleDateStr(b)))
    .map((c) => c.close)
    .filter((v) => Number.isFinite(v) && v > 0);
  if (closes.length < 51) return { factor: 1, isDown: false, reason: 'insufficient_history', bars: closes.length, prevClose: closes.length ? closes[closes.length - 1] : null };
  const sma = (n, end) => { let s = 0; for (let i = end - n + 1; i <= end; i++) s += closes[i]; return s / n; };
  const last = closes.length - 1;
  const prevClose = closes[last];
  const ma50 = sma(50, last);
  const ma20 = sma(20, last);
  const ma20Prior = sma(20, last - 5);
  const dist50 = ((prevClose - ma50) / ma50) * 100;
  const slope20 = ((ma20 - ma20Prior) / ma20Prior) * 100;
  const isDown = dist50 < 0 && slope20 < 0;
  return { factor: isDown ? downFactor : 1, isDown, dist50, slope20, prevClose, bars: closes.length };
}

async function main() {
  logToFile('start', 'script started');

  // Startup summary
  console.error(`[CONFIG] LIVE_TRADING=${LIVE_TRADING} | MAX_POSITIONS=${MAX_POSITIONS} | LIVE_TIERED_SIZING=${LIVE_TIERED_SIZING}`);
  console.error(`[CONFIG] Downtrend size-down: ${LIVE_DOWNTREND_SIZE_FACTOR === 1 ? 'OFF' : `×${LIVE_DOWNTREND_SIZE_FACTOR} on Smallcap-100 daily-downtrend days (token ${SMALLCAP_TOKEN})`}`);
  console.error(`[CONFIG] Intraday market gate: ${LIVE_MAX_MARKET_DOWN_PCT > 0 ? `skip entries while Smallcap-100 < -${LIVE_MAX_MARKET_DOWN_PCT}% vs prev close` : 'OFF'}`);
  if (LIVE_TIERED_SIZING) {
    const tierStr = LIVE_TIERS.map((v, i) => `#${i + 1}:₹${v.toLocaleString('en-IN')}`).join(' | ');
    const totalCapital = LIVE_TIERS.reduce((s, v) => s + v, 0);
    console.error(`[CONFIG] Tiers (${LIVE_CAPITAL > 0 ? `auto from ₹${LIVE_CAPITAL.toLocaleString('en-IN')} capital` : 'explicit'}): ${tierStr}`);
    console.error(`[CONFIG] Total if all ${LIVE_TIERS.length} fire: ₹${totalCapital.toLocaleString('en-IN')}`);
  }

  const symbols = loadWatchlistSymbols();
  if (symbols.length === 0) {
    console.error('No symbols in', WATCHLIST_PATH);
    logToFile('exit', 'no symbols in watchlist');
    process.exit(1);
  }

  const kite = await getKite();
  const instruments = await kite.getInstruments('NSE');

  const tokenToSymbol = new Map();
  const tokens = [];
  for (const sym of symbols) {
    if (tokens.length >= MAX_TOKENS) break;
    const rawToken = findInstrumentToken(instruments, sym);
    if (rawToken != null) {
      const token = Number(rawToken);
      tokens.push(token);
      tokenToSymbol.set(token, sym);
    }
  }
  console.error('Subscribing to', tokens.length, 'instruments (max', MAX_TOKENS + ')');
  logToFile('start', { tokens: tokens.length, watchlist: WATCHLIST_PATH });
  logToFile('start', { volume_debug: LOG_VOLUME_ENABLED, volume_debug_path: LOG_VOLUME_PATH });

  const symbolToToken = new Map();
  for (const [token, sym] of tokenToSymbol) symbolToToken.set(sym, token);

  const gapUpThresholdPct = process.env.GAP_UP_THRESHOLD_PCT != null ? parseFloat(process.env.GAP_UP_THRESHOLD_PCT) : null;
  const prevCloseBySymbol = new Map();
  const prevDayVolumeBySymbol = new Map();   // from daily OHLCV API only (prev day volume)
  const trendBySymbol = new Map();           // findings: multi-day trend context for dead-zone filter
  const dayOpenBySymbol = new Map();
  // Smallcap-100 daily-downtrend size factor for today (1 = full size until computed / on up days).
  let daySizeFactor = 1;
  // Smallcap-100 intraday regime: live index level (from ticker) vs yesterday's index close (from the
  // daily fetch). Both null until ready → the intraday market gate no-ops (entry allowed).
  let smallcapLtp = null;
  let smallcapPrevClose = null;
  const CONCURRENCY = 5; // reduced to avoid Kite API rate limits
  const symbolsForPrevDay = [...symbolToToken.keys()];
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  // 50 calendar days ≈ 35 trading days — enough history for 20-day trend features (was 7).
  const rangeFromStr = dateMinusDays(todayStr, 50);
  const dayFrom = new Date(`${rangeFromStr}T00:00:00+05:30`);
  const dayTo = new Date(`${todayStr}T23:59:59+05:30`);

  /** Prev-day fetch runs in background. Entry logic skips symbols until data is ready. */
  const fetchPrevDayData = async () => {
    const missingVolumeReasons = new Map();
    const totalBatches = Math.ceil(symbolsForPrevDay.length / CONCURRENCY);
    console.error('Prev day (background): loading close+volume, range', rangeFromStr, '→', todayStr, '(batch=', CONCURRENCY, ')');
    for (let i = 0; i < symbolsForPrevDay.length; i += CONCURRENCY) {
      const chunk = symbolsForPrevDay.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          let set = false;
          try {
            const token = symbolToToken.get(symbol);
            const candles = await kite.getHistoricalData(token, 'day', dayFrom, dayTo, false, false);
            if (candles && candles.length > 0) {
              const priorBars = [];
              for (const c of candles) {
                const d = candleDateStr(c);
                if (d < todayStr) {
                  prevCloseBySymbol.set(symbol, c.close);
                  prevDayVolumeBySymbol.set(symbol, c.volume ?? 0);
                  priorBars.push({ date: d, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 });
                  set = true;
                }
              }
              if (priorBars.length >= 5) {
                priorBars.sort((a, b) => a.date.localeCompare(b.date));
                const tf = computeTrendFeatures(priorBars);
                if (tf) trendBySymbol.set(symbol, tf);
              }
            }
            if (!set) {
              missingVolumeReasons.set(symbol, (!candles || candles.length === 0) ? 'no_candles' : 'no_prev_day_in_range');
            }
          } catch (e) {
            missingVolumeReasons.set(symbol, 'api_error: ' + (e && e.message ? e.message : String(e)));
          }
        })
      );
      const batchNum = Math.floor(i / CONCURRENCY) + 1;
      if (batchNum % 20 === 0 || batchNum === totalBatches) {
        console.error('Prev day (background):', batchNum, '/', totalBatches, '| ready:', prevDayVolumeBySymbol.size);
      }
      await new Promise((r) => setImmediate(r)); // yield so ticks/bars/heartbeat can run
    }
    const missingVol = symbolsForPrevDay.filter(s => !prevDayVolumeBySymbol.has(s));
    if (missingVol.length > 0) {
      await new Promise(r => setTimeout(r, 2000));
      for (let i = 0; i < missingVol.length; i += CONCURRENCY) {
        const chunk = missingVol.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(async (symbol) => {
          try {
            const token = symbolToToken.get(symbol);
            const candles = await kite.getHistoricalData(token, 'day', dayFrom, dayTo, false, false);
            if (candles?.length > 0) {
              for (const c of candles) {
                const d = candleDateStr(c);
                if (d < todayStr) {
                  prevCloseBySymbol.set(symbol, c.close);
                  prevDayVolumeBySymbol.set(symbol, c.volume ?? 0);
                  return;
                }
              }
            }
          } catch {}
        }));
      }
    }
    console.error('Prev day done:', prevDayVolumeBySymbol.size, '/', symbolsForPrevDay.length, '— entry logic active');
    logToFile('prev_day_ready', { count: prevDayVolumeBySymbol.size, total: symbolsForPrevDay.length });
  };
  fetchPrevDayData().catch((e) => {
    console.error('Prev day fetch failed:', e?.message);
    logToFile('prev_day_fatal', e?.message);
  });

  // Smallcap-100 regime (background; one daily-candle call). Feeds BOTH the daily size-down factor and
  // the intraday gate's prev-close. Entries don't fire before 10:45, so this resolves well in time.
  // Stays at full size (1) / no-op gate until ready or on errors.
  const fetchSmallcapRegime = async () => {
    const needFactor = LIVE_DOWNTREND_SIZE_FACTOR !== 1;
    const needGate = LIVE_MAX_MARKET_DOWN_PCT > 0;
    if (!needFactor && !needGate) {
      console.error('[REGIME] smallcap regime disabled (size-down off & market gate off)');
      return;
    }
    try {
      const info = await computeSmallcapDowntrend(kite, todayStr, SMALLCAP_TOKEN, LIVE_DOWNTREND_SIZE_FACTOR);
      if (needFactor) daySizeFactor = info.factor;
      if (info.prevClose != null) smallcapPrevClose = info.prevClose;
      const d50 = info.dist50 != null ? info.dist50.toFixed(2) : '?';
      const s20 = info.slope20 != null ? info.slope20.toFixed(2) : '?';
      console.error(`[REGIME] Smallcap-100 daily trend: dist50=${d50}% slope20=${s20}% (${info.bars} closes) → ${info.isDown ? 'DOWNTREND' : 'up/neutral'} | size factor ${daySizeFactor} | prevClose=${smallcapPrevClose ?? '?'}`);
      logToFile('regime', info);
      if (needFactor && info.isDown) {
        await sendAlert(`Smallcap-100 in a daily DOWNTREND (below 50-day MA & 20-day MA falling). Sizing today's trades down to ${Math.round(daySizeFactor * 100)}% of normal.`);
      }
    } catch (e) {
      console.error('[REGIME] smallcap regime fetch failed (full size, gate no-op):', e?.message);
      logToFile('regime_fatal', e?.message ?? String(e));
    }
  };
  fetchSmallcapRegime();

  const todayFrom = new Date(`${todayStr}T00:00:00+05:30`);
  const todayTo = new Date(`${todayStr}T23:59:59+05:30`);
  const fetchTodayOpen = async () => {
    const MAX_RETRIES = 4;
    const BASE_DELAY_MS = 1000;
    console.error('Loading today open (daily only) for gap filter:', symbolsForPrevDay.length, 'symbols (retry with exponential backoff)');
    for (let i = 0; i < symbolsForPrevDay.length; i += CONCURRENCY) {
      const chunk = symbolsForPrevDay.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            await withExponentialBackoff(async () => {
              const token = symbolToToken.get(symbol);
              const candles = await kite.getHistoricalData(token, 'day', todayFrom, todayTo, false, false);
              if (candles && candles.length > 0) {
                dayOpenBySymbol.set(symbol, candles[0].open);
                return;
              }
              throw new Error('No candles');
            }, MAX_RETRIES, BASE_DELAY_MS);
          } catch {
            // will be reported after all batches
          }
        })
      );
    }
    const failedSymbols = symbolsForPrevDay.filter((s) => !dayOpenBySymbol.has(s));
    console.error('Today open loaded:', dayOpenBySymbol.size, 'symbols (daily only; gap = prev close vs today open)');
    if (failedSymbols.length > 0) {
      const list = failedSymbols.length <= 30 ? failedSymbols.join(', ') : `${failedSymbols.slice(0, 30).join(', ')} ... +${failedSymbols.length - 30} more`;
      console.error('Today open fetch failed after retries for', failedSymbols.length, 'symbols:', list);
      logToFile('today_open_failed', { count: failedSymbols.length, symbols: failedSymbols });
      // Reasons: Kite returns no day candle for today yet, rate limit, or symbol suspended/delisted
      await sendAlert(`Today open could not be fetched for ${failedSymbols.length} symbols (gap filter may skip them): ${list}`);
    }
  };

  const delayMs = msUntil920Ist();
  if (delayMs > 0) {
    console.error('Today open deferred to 9:20 IST (in', Math.round(delayMs / 1000), 's)');
    setTimeout(() => { fetchTodayOpen().catch((e) => console.error('fetchTodayOpen failed', e?.message)); }, delayMs);
  } else {
    fetchTodayOpen().catch((e) => console.error('fetchTodayOpen failed', e?.message));
  }
  // Connect immediately — today open runs in background; gap filter skips when dayOpen not ready

  const sessionPath = path.join(process.cwd(), '.kite_session');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const apiKey = process.env.KITE_API_KEY || process.env.api_key || process.env.API_KEY;
  if (!apiKey || !session.access_token) {
    console.error('Missing KITE_API_KEY or no session. Run kite:login and set .env');
    process.exit(1);
  }

  const seriesBySymbol = new Map();
  const signaled = new Set();
  const pendingVolumeChecks = new Map();
  let barsClosedCount = 0;
  let lastHeartbeat = 0;
  let tickCount = 0;
  let volumeDebugCumulative = 0;
  let dailyTradeCount = 0;  // incremented after each confirmed entry; used for tiered sizing
  let volumeDebugSum = 0;
  let volumeCheckLoopBusy = false;

  // ── helpers ────────────────────────────────────────────────────────────────
  function pnlStr(pnl) {
    return pnl >= 0 ? `+₹${pnl.toFixed(2)}` : `-₹${Math.abs(pnl).toFixed(2)}`;
  }

  function logSummary(label) {
    const t = getTotalPnl();
    const msg = `${label} | realized=${pnlStr(t.realizedPnl)} | closed=${t.closedCount}(${t.wins}W/${t.losses}L) open=${t.openCount}`;
    console.error(msg);
    logToFile('summary', { label, ...t });
  }

  function hasPendingEntryForSymbolDate(symbol, date) {
    for (const pending of pendingVolumeChecks.values()) {
      if (pending.symbol === symbol && pending.date === date) return true;
    }
    return false;
  }

  async function fetchOfficialBarsForPendingEntry(symbol, date, targetTime5) {
    const token = symbolToToken.get(symbol);
    if (!token) return { ready: false, reason: 'missing_token' };
    const from = new Date(`${date}T09:15:00+05:30`);
    const to = new Date(`${date}T15:30:00+05:30`);
    const candles = await kite.getHistoricalData(token, '3minute', from, to, false, false);
    const officialBars = buildHistoricalBars(candles, date)
      .filter((b) => (b.time || '').slice(0, 5) <= targetTime5);
    const entryBar = officialBars.find((b) => (b.time || '').slice(0, 5) === targetTime5);
    const latestBarTime = officialBars.length ? officialBars[officialBars.length - 1].time : null;
    if (!entryBar) return { ready: false, reason: 'entry_bar_missing', officialBars };
    const cumVol = officialBars.reduce((s, b) => s + (b.volume || 0), 0);
    if (cumVol <= 0 || (entryBar.volume || 0) <= 0) {
      return { ready: false, reason: 'volume_not_ready', officialBars, entryBar, cumVol, latestBarTime };
    }
    return { ready: true, officialBars, entryBar, cumVol, latestBarTime };
  }

  async function confirmPendingVolumeChecks() {
    if (volumeCheckLoopBusy || pendingVolumeChecks.size === 0) return;
    volumeCheckLoopBusy = true;
    try {
      for (const [key, pending] of [...pendingVolumeChecks.entries()]) {
        pending.attempts += 1;
        try {
          logToFile('entry_pending_volume_poll', {
            symbol: pending.symbol,
            date: pending.date,
            time: pending.time,
            attempt: pending.attempts,
            pendingCount: pendingVolumeChecks.size,
            targetBarTime: pending.barTime5,
          });
          const official = await fetchOfficialBarsForPendingEntry(pending.symbol, pending.date, pending.barTime5);
          if (!official.ready) {
            logToFile('entry_pending_volume_poll_result', {
              symbol: pending.symbol,
              date: pending.date,
              time: pending.time,
              attempt: pending.attempts,
              ready: false,
              reason: official.reason,
              officialBarCount: official.officialBars?.length ?? 0,
              latestOfficialBarTime: official.latestBarTime ?? null,
              officialCumVol: official.cumVol ?? 0,
              officialEntryBarVol: official.entryBar?.volume ?? 0,
            });
            if (pending.attempts === 1 || pending.attempts % 6 === 0) {
              console.error(`[ENTRY_WAIT] ${pending.symbol} @ ${pending.time} | waiting for historical volume (${official.reason}) | attempt ${pending.attempts} | bars=${official.officialBars?.length ?? 0} latest=${official.latestBarTime ?? '-'} cumVol=${official.cumVol ?? 0} entryBarVol=${official.entryBar?.volume ?? 0}`);
              logToFile('entry_pending_volume_wait', {
                symbol: pending.symbol,
                date: pending.date,
                time: pending.time,
                attempt: pending.attempts,
                reason: official.reason,
                officialBarCount: official.officialBars?.length ?? 0,
                latestOfficialBarTime: official.latestBarTime ?? null,
                officialCumVol: official.cumVol ?? 0,
                officialEntryBarVol: official.entryBar?.volume ?? 0,
              });
            }
            continue;
          }

          logToFile('entry_pending_volume_poll_result', {
            symbol: pending.symbol,
            date: pending.date,
            time: pending.time,
            attempt: pending.attempts,
            ready: true,
            officialBarCount: official.officialBars.length,
            latestOfficialBarTime: official.latestBarTime ?? null,
            officialCumVol: official.cumVol,
            officialEntryBarVol: official.entryBar.volume,
            prevDayVol: pending.prevDay.volume ?? 0,
            dayVolMultiple: pending.prevDay.volume > 0 ? Number((official.cumVol / pending.prevDay.volume).toFixed(3)) : null,
          });

          const officialResult = findEntry(official.officialBars, pending.prevDay, {
            fixedSlPct: LIVE_FIXED_SL_PCT,
            minEntryTime: V2_MIN_ENTRY_TIME || null,
            trend: pending.trend ?? null,
            trendFilter: V2_TREND_FILTER,
            minAvgTurnover: V2_MIN_TURNOVER,
          });
          const officialTime5 = (officialResult?.time || '').slice(0, 5);
          if (!officialResult || officialTime5 !== pending.barTime5) {
            console.error(`[ENTRY_SKIP] ${pending.symbol} @ ${pending.time} | historical volume available but entry not confirmed`);
            logToFile('entry_volume_rejected', {
              symbol: pending.symbol,
              date: pending.date,
              time: pending.time,
              attempt: pending.attempts,
              reason: officialResult ? `entry_time_${officialTime5}` : 'no_entry_after_historical_volume',
              cumVol: official.cumVol,
              entryBarVol: official.entryBar?.volume ?? 0,
              prevDayVol: pending.prevDay.volume ?? 0,
              dayVolMultiple: pending.prevDay.volume > 0 ? Number((official.cumVol / pending.prevDay.volume).toFixed(3)) : null,
            });
            pendingVolumeChecks.delete(key);
            continue;
          }

          if (signaled.has(key)) {
            pendingVolumeChecks.delete(key);
            continue;
          }

          signaled.add(key);
          pendingVolumeChecks.delete(key);

          // max-positions guard — skip if already at the cap
          const openCount = getOpenPositions().length;
          if (openCount >= MAX_POSITIONS) {
            console.error(`[ENTRY_SKIP] ${pending.symbol} @ ${pending.time} | max positions reached (${openCount}/${MAX_POSITIONS})`);
            logToFile('entry_skipped_max_positions', { symbol: pending.symbol, date: pending.date, time: pending.time, openCount, MAX_POSITIONS });
            continue;
          }

          const entryPrice = officialResult.entry;
          const stop = officialResult.stop;
          const firstTargetPrice = Math.round(entryPrice * 1.03 * 100) / 100;
          const slPct = entryPrice > 0 ? ((entryPrice - stop) / entryPrice * 100).toFixed(2) : '?';
          // Position size: tier by sequence (if enabled), then scale by today's downtrend factor
          // (0.5 on Smallcap-100 daily-downtrend days; 1 otherwise / until the regime fetch resolves).
          const baseTierPv = LIVE_TIERED_SIZING
            ? LIVE_TIERS[Math.min(dailyTradeCount, LIVE_TIERS.length - 1)]
            : undefined;
          const tierPv = daySizeFactor !== 1
            ? Math.max(1000, Math.round((baseTierPv ?? POSITION_VALUE) * daySizeFactor))
            : baseTierPv;

          const pos = addPosition({
            symbol: pending.symbol,
            side: 'long',
            entryTime: `${pending.date} ${pending.time}`,
            entryPrice,
            stop,
            target: firstTargetPrice,
            signalType: 'v2_breakout',
            ...(tierPv !== undefined && { positionValue: tierPv }),
          });
          const qty = pos.qty;

          dailyTradeCount++;

          const msg = `[ENTRY] ${pending.symbol} #${pos.id} @ ${pending.time} | entry=${entryPrice} SL=${stop} (${slPct}%) 3%→trail | qty=${pos.qty}${LIVE_TIERED_SIZING ? ` | tier=${tierPv}` : ''}${daySizeFactor !== 1 ? ` | downtrend×${daySizeFactor}` : ''} | cumVol=${official.cumVol} | entryBarVol=${official.entryBar.volume} | volume=historical_api`;
          console.error(msg);
          logToFile('entry', {
            symbol: pending.symbol,
            date: pending.date,
            time: pending.time,
            id: pos.id,
            entry: entryPrice,
            stop,
            target: firstTargetPrice,
            slPct: parseFloat(slPct),
            qty,
            cumVol: official.cumVol,
            entryBarVol: official.entryBar.volume,
            prevDayVol: pending.prevDay.volume ?? 0,
            dayVolMultiple: pending.prevDay.volume > 0 ? Number((official.cumVol / pending.prevDay.volume).toFixed(3)) : null,
            volumeSource: 'historical_api',
            attempts: pending.attempts,
            sizeFactor: daySizeFactor,
            tierPv: tierPv ?? null,
          });
          if (!telegramConfigured()) {
            logToFile('telegram_skip', { reason: 'not_configured', symbol: pending.symbol, time: pending.time, msg: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env' });
          }
          const buyVal = Math.round(entryPrice * pos.qty * 100) / 100;
          sendAlert([
            'ENTRY',
            `Symbol: ${pending.symbol}`,
            `ID: #${pos.id}`,
            `Time: ${pending.time}`,
            `Entry: ₹${entryPrice}`,
            `SL: ₹${stop}`,
            `Qty: ${pos.qty}`,
            `Buy Value: ₹${buyVal.toLocaleString('en-IN')}`,
            '3% → trail',
          ].join('\n'));

          if (LIVE_TRADING) {
            await placeBuyOrder(kite, pending.symbol, pos.qty, logToFile, sendAlert);
          }
        } catch (e) {
          if (pending.attempts === 1 || pending.attempts % 6 === 0) {
            const reason = e?.message ?? String(e);
            console.error(`[ENTRY_WAIT] ${pending.symbol} @ ${pending.time} | historical volume retry failed: ${reason} | attempt ${pending.attempts}`);
            logToFile('entry_pending_volume_retry_error', {
              symbol: pending.symbol,
              date: pending.date,
              time: pending.time,
              attempt: pending.attempts,
              reason,
            });
          }
        }
      }
    } finally {
      volumeCheckLoopBusy = false;
    }
  }

  // ── Square-off 15:20 IST (LTP) — before bar EOD / MIS window ───────────────
  const todayISTForEod = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const squareOff1520At = new Date(`${todayISTForEod}T15:20:00+05:30`);
  const msTo1520 = squareOff1520At.getTime() - Date.now();
  if (msTo1520 > 0) {
    setTimeout(async () => {
      const open1520 = getOpenPositions();
      if (open1520.length === 0) return;
      /** @type {Record<string, number>} */
      const priceBySymbol = {};
      try {
        const ltp = await kite.getLTP(open1520.map((p) => `NSE:${p.symbol}`));
        for (const [key, row] of Object.entries(ltp || {})) {
          const sym = key.includes(':') ? key.split(':').slice(1).join(':') : key;
          const lp = row && typeof row === 'object' ? row.last_price : undefined;
          if (Number.isFinite(lp) && lp > 0) priceBySymbol[sym] = lp;
        }
      } catch (e) {
        const reason = e?.message ?? String(e);
        console.error('[SQ1520] getLTP failed:', reason);
        logToFile('squareoff_1520_ltp_error', reason);
      }
      const closed1520 = closeAllOpenAtPrices(todayISTForEod, '15:20:00', priceBySymbol, 'squareoff_1520');
      if (closed1520.length > 0) {
        console.error(`[SQ1520] Closed ${closed1520.length} open position(s) at LTP`);
        for (const p of closed1520) {
          console.error(`  ${p.symbol} #${p.id} → squareoff_1520 @ ${p.exitPrice} | P&L ${pnlStr(p.pnl)}`);
          logToFile('exit', { symbol: p.symbol, date: todayISTForEod, time: '15:20:00', id: p.id, reason: 'squareoff_1520', exitPrice: p.exitPrice, qty: p.qty, pnl: p.pnl });
          const buyVal1520 = Math.round(p.entryPrice * p.qty * 100) / 100;
          const sellVal1520 = Math.round(p.exitPrice * p.qty * 100) / 100;
          sendAlert([
            'EXIT (15:20 square-off)',
            `Symbol: ${p.symbol}`,
            `ID: #${p.id}`,
            `Time: 15:20`,
            `Buy Value: ₹${buyVal1520.toLocaleString('en-IN')}`,
            `Sell Value: ₹${sellVal1520.toLocaleString('en-IN')}`,
            `P&L: ${pnlStr(p.pnl)}`,
          ].join('\n'));
          if (LIVE_TRADING) {
            await placeSellOrder(kite, p.symbol, p.qty, logToFile, sendAlert);
          }
        }
        logSummary('SQ1520');
      }
    }, msTo1520);
  }

  // ── EOD sweep at 15:30 IST ─────────────────────────────────────────────────
  const eodSweepAt = new Date(`${todayISTForEod}T15:30:00+05:30`);
  const msToEod = eodSweepAt.getTime() - Date.now();
  if (msToEod > 0) {
    setTimeout(async () => {
      const swept = eodSweep(todayISTForEod);
      if (swept.length > 0) {
        console.error(`[EOD_SWEEP] Force-closed ${swept.length} positions that had no 15:24 bar`);
        for (const p of swept) {
          console.error(`  ${p.symbol} #${p.id} → eod_sweep @ ${p.exitPrice} | P&L ${pnlStr(p.pnl)}`);
          logToFile('exit', { symbol: p.symbol, date: todayISTForEod, time: '15:30', id: p.id, reason: 'eod_sweep', exitPrice: p.exitPrice, qty: p.qty, pnl: p.pnl });
          const buyValSweep = Math.round(p.entryPrice * p.qty * 100) / 100;
          const sellValSweep = Math.round(p.exitPrice * p.qty * 100) / 100;
          sendAlert([
            'EXIT (EOD sweep)',
            `Symbol: ${p.symbol}`,
            `ID: #${p.id}`,
            `Time: 15:30`,
            `Buy Value: ₹${buyValSweep.toLocaleString('en-IN')}`,
            `Sell Value: ₹${sellValSweep.toLocaleString('en-IN')}`,
            `P&L: ${pnlStr(p.pnl)}`,
          ].join('\n'));
          if (LIVE_TRADING) {
            await placeSellOrder(kite, p.symbol, p.qty, logToFile, sendAlert);
          }
        }
        logSummary('EOD_SWEEP');
      }
    }, msToEod);
  }

  // ── bar-close callback ─────────────────────────────────────────────────────
  const builder = createCandleBuilder(
    async (bar) => {
    const { symbol, date, time, open, high, low, close, volume } = bar;
    barsClosedCount++;

    // ── heartbeat every 5 min ──
    const now = Date.now();
    if (now - lastHeartbeat >= 5 * 60 * 1000) {
      lastHeartbeat = now;
      const t = getTotalPnl();
      const symCount = seriesBySymbol.size;
      const msg = `bars=${barsClosedCount} symbols=${symCount} ticks=${tickCount} | realized=${pnlStr(t.realizedPnl)} closed=${t.closedCount} open=${t.openCount}`;
      console.error(`[heartbeat] ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | ${msg}`);
      logToFile('heartbeat', {
        bars: barsClosedCount,
        symbols: symCount,
        ticks: tickCount,
        pending_volume_checks: pendingVolumeChecks.size,
        volume_debug: { cumulative_diff: volumeDebugCumulative, sum_quantity: volumeDebugSum },
        smallcap: {
          ltp: smallcapLtp,
          prevClose: smallcapPrevClose,
          pct: (smallcapLtp && smallcapPrevClose) ? Number((((smallcapLtp - smallcapPrevClose) / smallcapPrevClose) * 100).toFixed(2)) : null,
          sizeFactor: daySizeFactor,
        },
        ...t,
      });
    }

    // ── grow today's bar series ──
    let series = seriesBySymbol.get(symbol);
    if (!series) { series = {}; seriesBySymbol.set(symbol, series); }
    if (!series[date]) series[date] = [];
    series[date].push({ date, time, open, high, low, close, volume });

    // log every bar to file — only for symbols that HAVE/HAD a position today (keeps log focused)
    logToFile('bar', { symbol, date, time, open, high, low, close, volume });

    // ── STEP 1: process exits for existing open positions ──────────────────
    const exitResults = processBar(bar);
    for (const r of exitResults) {
      const pos = r.position;
      switch (r.action) {
        case 'exit_initial_sl': {
          const msg = `[EXIT] ${symbol} #${pos.id} INITIAL_SL @ ${time} | bar.low=${low} <= SL=${r.exitPrice} | qty=${r.qty} | P&L ${pnlStr(r.pnl)}`;
          console.error(msg);
          logToFile('exit', { symbol, date, time, id: pos.id, reason: 'initial_sl', barLow: low, exitPrice: r.exitPrice, qty: r.qty, pnl: r.pnl });
          logSummary('after_exit');
          const buyValSl = Math.round(pos.entryPrice * r.qty * 100) / 100;
          const sellValSl = Math.round(r.exitPrice * r.qty * 100) / 100;
          sendAlert([
            'EXIT (SL hit)',
            `Symbol: ${symbol}`,
            `ID: #${pos.id}`,
            `Time: ${time}`,
            `Buy Value: ₹${buyValSl.toLocaleString('en-IN')}`,
            `Sell Value: ₹${sellValSl.toLocaleString('en-IN')}`,
            `P&L: ${pnlStr(r.pnl)}`,
          ].join('\n'));
          if (LIVE_TRADING) {
            await placeSellOrder(kite, symbol, r.qty, logToFile, sendAlert);
          }
          break;
        }
        case 'exit_trail': {
          const msg = `[EXIT] ${symbol} #${pos.id} TRAIL_STOP @ ${time} | close=${close} <= trail=${r.trailLevel} (hwm=${r.hwm}) | qty=${r.qty} | P&L ${pnlStr(r.pnl)}`;
          console.error(msg);
          logToFile('exit', { symbol, date, time, id: pos.id, reason: 'trail_stop', close, trailLevel: r.trailLevel, hwm: r.hwm, exitPrice: r.exitPrice, qty: r.qty, pnl: r.pnl });
          logSummary('after_exit');
          const buyValTrail = Math.round(pos.entryPrice * r.qty * 100) / 100;
          const sellValTrail = Math.round(r.exitPrice * r.qty * 100) / 100;
          sendAlert([
            'EXIT (trail stop)',
            `Symbol: ${symbol}`,
            `ID: #${pos.id}`,
            `Time: ${time}`,
            `Buy Value: ₹${buyValTrail.toLocaleString('en-IN')}`,
            `Sell Value: ₹${sellValTrail.toLocaleString('en-IN')}`,
            `P&L: ${pnlStr(r.pnl)}`,
          ].join('\n'));
          if (LIVE_TRADING) {
            await placeSellOrder(kite, symbol, r.qty, logToFile, sendAlert);
          }
          break;
        }
        case 'exit_eod': {
          const msg = `[EXIT] ${symbol} #${pos.id} EOD @ ${time} | close=${close} | qty=${r.qty} | P&L ${pnlStr(r.pnl)}`;
          console.error(msg);
          logToFile('exit', { symbol, date, time, id: pos.id, reason: 'eod', exitPrice: r.exitPrice, qty: r.qty, pnl: r.pnl });
          logSummary('after_eod_exit');
          const buyValEod = Math.round(pos.entryPrice * r.qty * 100) / 100;
          const sellValEod = Math.round(r.exitPrice * r.qty * 100) / 100;
          sendAlert([
            'EXIT (EOD)',
            `Symbol: ${symbol}`,
            `ID: #${pos.id}`,
            `Time: ${time}`,
            `Buy Value: ₹${buyValEod.toLocaleString('en-IN')}`,
            `Sell Value: ₹${sellValEod.toLocaleString('en-IN')}`,
            `P&L: ${pnlStr(r.pnl)}`,
          ].join('\n'));
          if (LIVE_TRADING) {
            await placeSellOrder(kite, symbol, r.qty, logToFile, sendAlert);
          }
          break;
        }
        case 'first_target_hit': {
          const msg = `[TARGET] ${symbol} #${pos.id} 3% TARGET HIT @ ${time} | close=${close} >= ${r.firstTargetPrice} | unrealized=${pnlStr(r.unrealizedPnl)} | trailing from hwm=${r.hwm}`;
          console.error(msg);
          logToFile('first_target', { symbol, date, time, id: pos.id, close, firstTargetPrice: r.firstTargetPrice, unrealizedPnl: r.unrealizedPnl, hwm: r.hwm });
          const buyValTgt = Math.round(pos.entryPrice * r.qty * 100) / 100;
          sendAlert([
            'TARGET (3% hit)',
            `Symbol: ${symbol}`,
            `ID: #${pos.id}`,
            `Time: ${time}`,
            `Close: ₹${close}`,
            `Buy Value: ₹${buyValTgt.toLocaleString('en-IN')}`,
            `Unrealized: ${pnlStr(r.unrealizedPnl)}`,
            '→ now trailing',
          ].join('\n'));
          break;
        }
        case 'hold_trail':
          logToFile('position_bar', { symbol, date, time, id: pos.id, mode: 'trail', close, high, hwm: r.hwm, trailLevel: r.trailLevel, unrealizedPnl: r.unrealizedPnl, qty: r.qty });
          break;
        case 'hold':
          logToFile('position_bar', { symbol, date, time, id: pos.id, mode: 'initial', close, high, low, stop: r.stop, firstTargetPrice: r.firstTargetPrice, unrealizedPnl: r.unrealizedPnl, qty: r.qty });
          break;
      }
    }

    // ── STEP 2: v2 entry logic — always run; skip only when data missing
    const todayBars = series[date] || [];
    if (todayBars.length < 21) return;

    const prevClose = prevCloseBySymbol.get(symbol) ?? null;
    const prevVol = prevDayVolumeBySymbol.get(symbol) ?? 0;
    if (!prevClose || prevClose <= 0) return; // prev-day data not ready yet
    const prevDay = { close: prevClose, volume: prevVol };

    let skipEntry = false;
    if (gapUpThresholdPct != null && Number.isFinite(gapUpThresholdPct)) {
      const dayOpen = dayOpenBySymbol.get(symbol);
      if (dayOpen != null && dayOpen > prevClose) {
        const gapPct = ((dayOpen - prevClose) / prevClose) * 100;
        if (gapPct >= gapUpThresholdPct) {
          logToFile('skip', { symbol, date, time, reason: `gap_override_${gapPct.toFixed(1)}pct >= ${gapUpThresholdPct}pct` });
          skipEntry = true;
        }
      }
    }
    if (!skipEntry) {
      const officialDayOpen = dayOpenBySymbol.get(symbol);
      const trend = trendBySymbol.get(symbol) ?? null;
      const result = findEntryIgnoringVolumeForCurrentBar(todayBars, prevClose, officialDayOpen, trend);
      const resultTime5 = (result?.time || '').slice(0, 5);
      const barTime5 = (time || '').slice(0, 5);
      if (result && resultTime5 === barTime5) {
        // intraday market-regime gate: skip while Smallcap-100 is deeply red vs prev close at this bar.
        // No-op until the index level / prev close are available (matches backtest's "no regime data" case).
        if (LIVE_MAX_MARKET_DOWN_PCT > 0 && smallcapPrevClose && smallcapLtp) {
          const mPct = ((smallcapLtp - smallcapPrevClose) / smallcapPrevClose) * 100;
          if (mPct < -LIVE_MAX_MARKET_DOWN_PCT) {
            console.error(`[ENTRY_SKIP] ${symbol} @ ${time} | market gate: Smallcap-100 ${mPct.toFixed(2)}% < -${LIVE_MAX_MARKET_DOWN_PCT}% vs prev close`);
            logToFile('skip', { symbol, date, time, reason: `market_${mPct.toFixed(2)}pct < -${LIVE_MAX_MARKET_DOWN_PCT}pct`, smallcapLtp, smallcapPrevClose });
            return;
          }
        }
        const key = `${symbol}|${date}|v2_breakout|${time}`;
        if (!signaled.has(key) && !pendingVolumeChecks.has(key) && !hasPendingEntryForSymbolDate(symbol, date)) {
          const liveCumVol = todayBars.reduce((s, b) => s + (b.volume ?? 0), 0);
          pendingVolumeChecks.set(key, {
            symbol,
            date,
            time,
            barTime5,
            prevDay,
            trend,
            attempts: 0,
          });
          console.error(`[ENTRY_WAIT] ${symbol} @ ${time} | price structure matched, waiting for historical day volume + entry candle volume`);
          logToFile('entry_pending_volume', {
            symbol,
            date,
            time,
            key,
            liveCumVol,
            liveEntryBarVol: volume,
            prevDayVol: prevVol,
            liveDayVolMultiple: prevVol > 0 ? Number((liveCumVol / prevVol).toFixed(3)) : null,
            volumeSource: 'waiting_for_historical_api',
            pendingCount: pendingVolumeChecks.size,
          });
          confirmPendingVolumeChecks().catch((e) => {
            const reason = e?.message ?? String(e);
            console.error('confirmPendingVolumeChecks failed', reason);
            logToFile('entry_pending_volume_fatal', reason);
          });
        } else {
          logToFile('entry_pending_volume_skip_queue', {
            symbol,
            date,
            time,
            key,
            alreadySignaled: signaled.has(key),
            alreadyPendingForKey: pendingVolumeChecks.has(key),
            alreadyPendingForSymbolDate: hasPendingEntryForSymbolDate(symbol, date),
          });
        }
      }
    }
  }, {
    onVolumeFlush(info) {
      if (info.volumeSource === 'cumulative_diff') volumeDebugCumulative++;
      else volumeDebugSum++;
      logVolumeFlush(info);
    },
  });

  const ticker = new KiteTicker({
    api_key: apiKey,
    access_token: session.access_token,
  });

  ticker.on('ticks', (ticks) => {
    tickCount += ticks.length;
    for (const t of ticks) {
      const token = typeof t.instrument_token === 'number' ? t.instrument_token : Number(t.instrument_token);
      if (token === SMALLCAP_TOKEN) {
        if (Number.isFinite(t.last_price) && t.last_price > 0) smallcapLtp = t.last_price;
        continue;
      }
      const symbol = tokenToSymbol.get(token);
      if (!symbol) continue;
      const ts = t.exchange_timestamp || t.last_trade_time;
      const when = ts instanceof Date ? ts : (typeof ts === 'string' ? new Date(ts) : new Date());
      builder.addTick(token, symbol, t.last_price || 0, t.last_traded_quantity || 0, when, t.volume);
    }
  });

  ticker.on('connect', () => {
    // Also subscribe the Smallcap-100 index (for the intraday gate / regime) when either feature is on.
    const trackIndex = LIVE_MAX_MARKET_DOWN_PCT > 0 || LIVE_DOWNTREND_SIZE_FACTOR !== 1;
    const subTokens = trackIndex ? [...tokens, SMALLCAP_TOKEN] : tokens;
    ticker.subscribe(subTokens);
    ticker.setMode(ticker.modeFull, subTokens);
    const msg = `subscribed to ${subTokens.length} tokens${trackIndex ? ` (incl. Smallcap-100 index ${SMALLCAP_TOKEN})` : ''}`;
    console.error('Connected. Building 3m bars; signals will be logged and sent to Telegram if configured.');
    if (LOG_VOLUME_ENABLED) {
      console.error('Volume debug: logging each bar flush (volume, cumulative_diff vs sum_quantity) to', LOG_VOLUME_PATH);
    }
    if (!telegramConfigured()) {
      console.error('Telegram not configured — no alerts will be sent. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
      logToFile('telegram', 'not_configured');
    }
    logToFile('connect', msg);
  });

  setInterval(() => {
    confirmPendingVolumeChecks().catch((e) => {
      const reason = e?.message ?? String(e);
      console.error('confirmPendingVolumeChecks failed', reason);
      logToFile('entry_pending_volume_fatal', reason);
    });
  }, 5000);

  ticker.on('disconnect', (err) => {
    let reason = '(no reason)';
    if (err && typeof err === 'object') {
      if (err.code != null) reason = `code ${err.code}`;
      if (err.reason && String(err.reason).trim()) reason += ` ${err.reason}`.trim();
      else if (err.message) reason = err.message;
    } else if (err != null) reason = String(err);
    console.error('Disconnected', reason, '(will reconnect if possible)');
    logToFile('disconnect', reason);
  });
  ticker.on('error', (err) => {
    const msg = err?.message ?? (err && typeof err === 'object' ? `code ${err.code ?? ''} ${err.reason ?? ''}`.trim() : String(err));
    console.error('Ticker error', msg);
    logToFile('error', msg || (err?.message ?? String(err)));
  });
  ticker.on('noreconnect', () => {
    console.error('Ticker gave up reconnecting.');
    logToFile('noreconnect', 'gave up reconnecting');
  });

  ticker.connect();
}

main().catch((err) => {
  console.error(err);
  logToFile('fatal', err?.message ?? String(err));
  process.exit(1);
});
