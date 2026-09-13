/**
 * Watchlist breadth gate: skip entries when too few names are above 20d SMA.
 */

import { smaAtEnd } from './indicators.js';
import { loadDailyForSymbol } from './loadV3Data.js';

export const BREADTH_DEFAULTS = {
  /** Min fraction of watchlist above 20d SMA (0.5 = 50%). */
  minPct: 0.5,
  minDailyBars: 20,
};

function parseBreadthMinPct(value) {
  if (value == null || value === '') return BREADTH_DEFAULTS.minPct;
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return BREADTH_DEFAULTS.minPct;
  return n > 1 ? n / 100 : n;
}

export function breadthFilterFromEnv(env = process.env) {
  const disabled = env.V3_BREADTH_FILTER === 'false' || env.V3_BREADTH_FILTER === '0';
  return {
    enabled: !disabled,
    minPct: parseBreadthMinPct(env.V3_BREADTH_MIN_PCT),
    minDailyBars: parseInt(env.V3_BREADTH_MIN_DAILY_BARS || String(BREADTH_DEFAULTS.minDailyBars), 10),
  };
}

/** Whether last completed daily close (before asOfDate) is above 20d SMA. */
export function isAboveSma20AsOf(dailyBars, asOfDate, minDailyBars = BREADTH_DEFAULTS.minDailyBars) {
  const completed = (dailyBars || []).filter((b) => b.date < asOfDate);
  if (completed.length < minDailyBars) return null;

  const sma20 = smaAtEnd(completed.map((b) => b.close), 20);
  if (sma20 == null) return null;

  const last = completed[completed.length - 1];
  return last.close > sma20;
}

/**
 * @param {string[]} symbols watchlist symbols
 * @param {string} asOfDate entry date YYYY-MM-DD
 * @param {function} loadDaily defaults to cached CSV loader
 */
export function computeWatchlistBreadth(symbols, asOfDate, loadDaily = loadDailyForSymbol, opts = {}) {
  const cfg = { ...BREADTH_DEFAULTS, ...opts };
  let above = 0;
  let total = 0;

  for (const sym of symbols) {
    const daily = loadDaily(sym);
    if (!daily?.length) continue;
    const isAbove = isAboveSma20AsOf(daily, asOfDate, cfg.minDailyBars);
    if (isAbove === null) continue;
    total++;
    if (isAbove) above++;
  }

  const pct = total > 0 ? above / total : null;
  return {
    asOfDate,
    above,
    total,
    pct: pct == null ? null : Math.round(pct * 1000) / 1000,
    pctDisplay: pct == null ? null : Math.round(pct * 1000) / 10,
  };
}

export function passesBreadthFilter(breadthResult, opts = {}) {
  const cfg = { ...BREADTH_DEFAULTS, ...opts };
  if (cfg.enabled === false || cfg.minPct <= 0) {
    return { pass: true, reason: null, minPct: cfg.minPct, ...breadthResult };
  }
  if (breadthResult.pct == null) {
    return { pass: false, reason: 'breadth_insufficient_data', minPct: cfg.minPct, ...breadthResult };
  }
  const pass = breadthResult.pct >= cfg.minPct;
  return {
    pass,
    reason: pass ? null : 'breadth_below_min',
    minPct: cfg.minPct,
    ...breadthResult,
  };
}

export function checkBreadthForDate(symbols, asOfDate, opts = {}, loadDaily = loadDailyForSymbol) {
  const breadth = computeWatchlistBreadth(symbols, asOfDate, loadDaily, opts);
  return passesBreadthFilter(breadth, opts);
}
