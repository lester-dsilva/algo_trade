/**
 * Daily screener for v3 swing strategy.
 * Simple uptrend + recent momentum gate. No v2 intraday filters.
 */

import { smaAtEnd } from './indicators.js';

export const SCREEN_DEFAULTS = {
  smaProximityMinPct: -1,
  smaProximityMaxPct: 12,
  minDailyBars: 20,
};

function retPct(bars, n) {
  if (bars.length <= n) return null;
  const last = bars[bars.length - 1].close;
  const ago = bars[bars.length - 1 - n].close;
  return ago > 0 ? ((last - ago) / ago) * 100 : null;
}

/**
 * @param {Array<{ date, open, high, low, close, volume }>} dailyBars sorted ascending
 * @param {object} opts
 */
export function screenDaily(dailyBars, opts = {}) {
  const cfg = { ...SCREEN_DEFAULTS, ...opts };
  const reasons = [];

  if (!Array.isArray(dailyBars) || dailyBars.length < cfg.minDailyBars) {
    return { pass: false, score: 0, reasons: ['insufficient_daily_bars'], sma20: null };
  }

  const last = dailyBars[dailyBars.length - 1];
  const closes = dailyBars.map((b) => b.close);
  const sma20 = smaAtEnd(closes, 20);
  if (sma20 == null) {
    return { pass: false, score: 0, reasons: ['sma20_unavailable'], sma20: null };
  }

  const distFromSMA20 = ((last.close - sma20) / sma20) * 100;
  if (distFromSMA20 < cfg.smaProximityMinPct) {
    reasons.push('below_sma20_zone');
  }
  if (distFromSMA20 > cfg.smaProximityMaxPct) {
    reasons.push('above_sma20_zone');
  }

  const ret5 = retPct(dailyBars, 5);
  const pass = reasons.length === 0;
  let score = 0;
  if (ret5 != null) score += Math.min(ret5 * 2, 40);
  if (last.close > sma20) score += 10;
  score += Math.min((last.volume / (dailyBars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20)) * 5, 20);

  return {
    pass,
    score: Math.round(score * 100) / 100,
    reasons,
    sma20,
    distFromSMA20,
    ret5,
  };
}

/**
 * Daily SMA proximity at entry time — completed daily bars only, entry price vs SMA20.
 * @param {Array<{ date, close }>} dailyBars
 * @param {string} entryDate YYYY-MM-DD of the entry bar
 * @param {number} entryPrice hourly close at entry
 */
export function checkDailySmaAtEntry(dailyBars, entryDate, entryPrice, opts = {}) {
  const cfg = { ...SCREEN_DEFAULTS, ...opts };
  if (!entryPrice || !entryDate) {
    return { pass: false, reason: 'missing_entry', sma20: null, distFromSMA20: null };
  }

  const completed = (dailyBars || []).filter((b) => b.date < entryDate);
  if (completed.length < cfg.minDailyBars) {
    return { pass: false, reason: 'insufficient_daily_bars', sma20: null, distFromSMA20: null };
  }

  const closes = completed.map((b) => b.close);
  const sma20 = smaAtEnd(closes, 20);
  if (sma20 == null) {
    return { pass: false, reason: 'sma20_unavailable', sma20: null, distFromSMA20: null };
  }

  const distFromSMA20 = ((entryPrice - sma20) / sma20) * 100;
  if (distFromSMA20 < cfg.smaProximityMinPct) {
    return { pass: false, reason: 'below_sma20_zone', sma20, distFromSMA20 };
  }
  if (distFromSMA20 > cfg.smaProximityMaxPct) {
    return { pass: false, reason: 'above_sma20_zone', sma20, distFromSMA20 };
  }

  return { pass: true, sma20, distFromSMA20 };
}

export function screenUniverse(symbolDailyMap, opts = {}) {
  const results = [];
  for (const [symbol, bars] of symbolDailyMap.entries()) {
    const res = screenDaily(bars, opts);
    results.push({ symbol, ...res });
  }
  return results.filter((r) => r.pass).sort((a, b) => b.score - a.score);
}
